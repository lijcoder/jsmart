import type { AgentTool, StreamFn } from "@jsmart/jsmart-agent-core";
import { Agent, type AgentEvent, type AgentMessage } from "@jsmart/jsmart-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@jsmart/jsmart-ai";
import { isContextOverflow } from "@jsmart/jsmart-ai";
import { MemoryManager } from "@jsmart/jsmart-memory";
import {
	type CompactionResult,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTotalTokens,
	prepareCompaction,
	shouldCompact,
} from "./compaction.js";
import { convertToLlm } from "./messages.js";
import type { ModelManager } from "./model-manager.js";
import { buildSystemPrompt } from "./prompts.js";
import { DefaultResourceLoader, type ResourceLoader } from "./resource-manager.js";
import { getLatestCompactionEntry, type SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import { createMemoryTool, createSessionSearchTool } from "./tools/index.js";
import { sleep } from "./utils/sleep.js";

const MEMORY_GUIDANCE = `You have persistent memory across sessions. Save durable facts using the memory
tool: user preferences, environment details, tool quirks, and stable conventions.
Memory is injected into every turn, so keep it compact and focused on facts that
will still matter later.

Prioritize what reduces future user steering — the most valuable memory is one
that prevents the user from having to correct or remind you again.
User preferences and recurring corrections matter more than procedural task details.

Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO
state to memory; use session_search to recall those from past transcripts.

TWO TARGETS:
- 'user': who the user is — name, role, preferences, communication style, pet peeves
- 'memory': your notes — environment facts, project conventions, tool quirks, lessons learned`;

export interface ResultState<T> {
	isSuccess: boolean;
	error?: string;
	result?: T;
}
/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| AgentEvent
	| { type: "slash_command"; name: string; message: string }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent, signal?: AbortSignal) => void;

export interface AgentSessionOptions {
	/** 自定义提示词模板 */
	promptTemplate?: string;
	/** 自定义内容，替换 {{custom}} 占位符 */
	customContent?: string | (() => string);
	/** Tools to use. If not provided, defaults to createTools(createExecutor()) */
	tools?: AgentTool<any>[];
	streamFn?: StreamFn;
	/** Memory configuration. If provided, memory + session_search tools are auto-added. */
	memory?: {
		memoryDir: string;
		userId: string;
		projectId?: string;
		summarizationModel: import("@jsmart/jsmart-ai").Model<import("@jsmart/jsmart-ai").Api>;
		summarizationApiKey?: string;
	};
}

export class AgentSession {
	private workspace: string;
	private sessionManager: SessionManager;
	private resourceLoader: ResourceLoader;
	private settingsManager: SettingsManager;

	// model state
	private providerName: string;
	private modelName: string;
	private modelManager: ModelManager;

	private agent: Agent;
	// Memory
	private memoryManager?: MemoryManager;
	// Event subscription state
	private _unsubscribeAgent?: () => void;

	private _eventListeners: AgentSessionEventListener[] = [];
	private _agentEventQueue: Promise<void> = Promise.resolve();

	// Compaction state
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;

	// Retry state
	private _retryAttempt = 0;
	private _retryAbortController: AbortController | undefined = undefined;

	constructor(
		workspace: string,
		settingsManager: SettingsManager,
		sessionManager: SessionManager,
		modelManager: ModelManager,
		options?: AgentSessionOptions,
	) {
		this.workspace = workspace;
		this.settingsManager = settingsManager;
		this.sessionManager = sessionManager;
		this.modelManager = modelManager;
		this.resourceLoader = new DefaultResourceLoader({
			skillPaths: settingsManager.getSkillPaths(),
			noSkills: settingsManager.getNoSkills(),
		});
		const defaultModel = settingsManager.getDefaultModel();
		this.providerName = defaultModel?.provider ?? "";
		this.modelName = defaultModel?.model ?? "";
		let model: Model<Api> | undefined = this.modelManager.find(this.providerName, this.modelName);
		const { messages } = this.sessionManager.buildSessionContext();

		// Restore last saved model / thinking level from session file
		const lastModel = this.sessionManager.loadLatestModelChange();
		if (lastModel) {
			this.providerName = lastModel.provider;
			this.modelName = lastModel.modelId;
			model = this.modelManager.find(this.providerName, this.modelName) ?? model;
		}
		const lastThinkingLevel = this.sessionManager.loadLatestThinkingLevel();

		this.agent = new Agent({
			initialState: {
				model: model,
				thinkingLevel: (lastThinkingLevel ?? defaultModel?.thinkingLevel ?? "off") as
					| "off"
					| "low"
					| "medium"
					| "high",
				messages: messages,
			},
			toolExecution: "sequential",
			getApiKey: async (provider) => {
				return this.modelManager.getApiKeyForProvider(provider);
			},
			streamFn: options?.streamFn,
			convertToLlm: convertToLlm,
		});
		const tools = options?.tools ?? [];
		this.agent.state.tools = tools;
		const skills = this.resourceLoader.getSkills();
		const systemPrompt = buildSystemPrompt({
			workspace: workspace,
			selectedTools: tools,
			skills: skills,
			template: options?.promptTemplate,
			customContent: options?.customContent,
		});
		this.agent.state.systemPrompt = systemPrompt;
		this._initMemory(options, tools, skills, workspace);
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/** Initialize memory manager, inject tools, and rebuild system prompt. */
	private _initMemory(
		options: AgentSessionOptions | undefined,
		tools: AgentTool<any>[],
		skills: any,
		workspace: string,
	): void {
		const memCfg = options?.memory;
		if (!memCfg) return;

		this.memoryManager = new MemoryManager({
			memoryDir: memCfg.memoryDir,
			userId: memCfg.userId,
			projectId: memCfg.projectId,
			summarizationModel: memCfg.summarizationModel,
			summarizationApiKey: memCfg.summarizationApiKey,
		});
		this.memoryManager.ensureDir();

		const memoryTools = [createMemoryTool(this.memoryManager), createSessionSearchTool(this.memoryManager)];
		this.agent.state.tools = [...tools, ...memoryTools];

		const memPrompt = this.memoryManager.formatForPrompt();
		this.agent.state.systemPrompt = buildSystemPrompt({
			workspace,
			selectedTools: [...tools, ...memoryTools],
			skills,
			template: options?.promptTemplate,
			variables: {
				memory: memPrompt ?? "",
				guidance: MEMORY_GUIDANCE,
			},
			customContent: options?.customContent,
		});
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = (event: AgentEvent, signal: AbortSignal): void => {
		this._agentEventQueue = this._agentEventQueue.then(
			() => this._processAgentEvent(event, signal),
			() => this._processAgentEvent(event, signal),
		);

		// Keep queue alive if an event handler fails
		this._agentEventQueue.catch(() => {});
	};

	private async _processAgentEvent(event: AgentEvent, signal: AbortSignal): Promise<void> {
		if (event.type === "message_start") {
			if (event.message.role === "user") {
				this._overflowRecoveryAttempted = false;
			}
		}

		if (event.type === "message_end") {
			if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// record session histroy
				this.sessionManager.appendMessage(event.message);
			}

			if (event.message.role === "assistant") {
				// track last assistant message
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;

				// Track assistant message for auto-compaction (checked on agent_end)
				if (assistantMsg.stopReason !== "error") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}

		// Memory: persist session messages on agent_end
		if (event.type === "agent_end" && this.memoryManager) {
			const sessionId = this.sessionManager.getSessionId();
			const modelName = `${this.providerName}/${this.modelName}`;
			const aiMessages = event.messages.filter(
				(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
			) as import("@jsmart/jsmart-ai").Message[];
			if (aiMessages.length > 0) {
				this.memoryManager.insertSessionMessages(sessionId, "cli", modelName, aiMessages);
			}
		}

		// Notify all listeners
		this._emit(event, signal);
	}

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent, signal?: AbortSignal): void {
		for (const l of this._eventListeners) {
			l(event, signal);
		}
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		this._disconnectFromAgent();
		this._eventListeners = [];
	}

	async prompt(text: string): Promise<void> {
		// slash command execute
		const userText = text.trim();
		if (userText.startsWith("/")) {
			if (this._slashCommand(text)) {
				return;
			}
		}
		// steer message
		if (this.isProcessing()) {
			this.agent.steer({
				role: "user",
				timestamp: Date.now(),
				content: userText,
			});
			return;
		}

		try {
			await this.agent.prompt(userText);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			// ignore
		}
	}

	_slashCommand(text: string): boolean {
		if (text === "/abort") {
			this.abort().catch(() => {});
			return true;
		}
		if (text === "/model") {
			this._emit({ type: "slash_command", name: "model", message: this.getModelName() });
			return true;
		}
		if (text === "/models") {
			const modelNames = this.getAllModelName();
			const msg = `Available models:\n${modelNames.map((name) => `- ${name}`).join("\n")}`;
			this._emit({ type: "slash_command", name: "models", message: msg });
			return true;
		}
		if (text.startsWith("/model set")) {
			const parts = text.replace("/model set", "").trim().split("/");
			let msg = "";
			if (parts.length === 2) {
				const [provider, model] = parts;
				this.changeModel(provider, model);
				msg = `Model changed to ${provider}/${model}`;
			} else {
				msg = "[ERROR] format error. \nUsage: /model set provider/model";
			}
			this._emit({ type: "slash_command", name: "model_set", message: msg });
			return true;
		}
		if (text === "/workspace") {
			const msg = `Current workspace: ${this.getWorkspace()}`;
			this._emit({ type: "slash_command", name: "workspace", message: msg });
			return true;
		}
		if (text === "/session") {
			const sessionFile = this.getSessionFilePath();
			const msg = sessionFile ? `Session file: ${sessionFile}` : "No session file path available";
			this._emit({ type: "slash_command", name: "session", message: msg });
			return true;
		}
		if (text === "/tokens") {
			const messages = this.agent.state.messages;
			let lastUsage: Usage | null = null;
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i] as { role: string; usage?: Usage };
				if (m.role === "assistant" && m.usage) {
					lastUsage = m.usage;
					break;
				}
			}

			const parts = [`context: ${this.getContextTokens()}`];
			if (lastUsage) {
				parts.push(
					`input: ${lastUsage.input}  output: ${lastUsage.output}  total: ${lastUsage.totalTokens}`,
					`cacheRead: ${lastUsage.cacheRead}  cacheWrite: ${lastUsage.cacheWrite}`,
				);
			} else {
				parts.push("(no usage data)");
			}

			this._emit({ type: "slash_command", name: "tokens", message: parts.join("\n") });
			return true;
		}
		if (text === "/prompt") {
			const msg = this.getSystemPrompt();
			this._emit({ type: "slash_command", name: "prompt", message: msg });
			return true;
		}
		return false;
	}

	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
	}

	/** Abort the current agent run, if one is active. */
	abort(): Promise<void> {
		this.agent.abort();
		return this.agent.waitForIdle();
	}

	/** Check if the agent is currently processing a prompt. */
	isProcessing(): boolean {
		return this.agent.state.isStreaming;
	}

	getWorkspace(): string {
		return this.workspace;
	}

	messageCount(): number {
		return this.agent.state.messages.length;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	getModelName(): string {
		return `${this.providerName}/${this.modelName}`;
	}

	getModel(): Model<any> | undefined {
		return this.agent.state.model;
	}

	changeModel(providerName: string, modelName: string): ResultState<void> {
		const model = this.modelManager.find(providerName, modelName);
		if (!model) {
			return { isSuccess: false, error: `${providerName}/${modelName} not found` };
		} else {
			this.providerName = providerName;
			this.modelName = modelName;
			this.agent.state.model = model;
			this.sessionManager.saveModelChange(providerName, modelName);
			return { isSuccess: true };
		}
	}

	setThinkingLevel(level: "off" | "low" | "medium" | "high"): void {
		this.agent.state.thinkingLevel = level;
		this.sessionManager.saveThinkingLevelChange(level);
	}

	getThinkingLevel(): string {
		return this.agent.state.thinkingLevel;
	}

	getAllModelName(): string[] {
		const modelNames = [];
		for (const m of this.modelManager.getAll()) {
			modelNames.push(`${m.provider}/${m.id}`);
		}
		return modelNames;
	}

	getModels(): Model<Api>[] {
		return this.modelManager.getAll();
	}

	getSessionFilePath(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	getSessionId(): string {
		return this.sessionManager.getSessionId();
	}

	getMemoryManager(): MemoryManager | undefined {
		return this.memoryManager;
	}

	/** Get current context token count */
	getContextTokens(): number {
		return estimateTotalTokens(this.agent.state.messages);
	}

	/** Get the system prompt */
	getSystemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Check if compaction is needed */
	needsCompaction(contextWindow: number): boolean {
		const tokens = this.getContextTokens();
		return shouldCompact(tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS);
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		// retry
		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		// compact
		return await this._checkCompaction(msg);
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// Context overflow is handled by compaction, not retry
		const contextWindow = this.getModel()?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		const err = message.errorMessage;
		// Match: overloaded_error, provider returned error, rate limit, 429, 500, 502, 503, 504, service unavailable, network/connection errors (including connection lost), WebSocket transport closes/errors, fetch failed, premature stream endings, HTTP/2 closed before response, terminated, retry delay exceeded
		return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i.test(
			err,
		);
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	// =========================================================================
	// Compact
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(_customInstructions?: string): Promise<CompactionResult> {
		this._disconnectFromAgent();
		await this.abort();
		this._compactionAbortController = new AbortController();
		const compactionRef = this.settingsManager.getCompactionModel();
		const compProvider = compactionRef?.provider ?? this.providerName;
		const compModel = compactionRef?.model ?? this.modelName;
		const model: Model<Api> | undefined = this.modelManager.find(compProvider, compModel);
		const modelApiKey = await this.modelManager.getApiKeyForProvider(compProvider);
		try {
			if (!model) {
				throw new Error("No model selected");
			}

			if (!modelApiKey) {
				throw new Error(`No API key for ${compProvider}`);
			}

			const pathEntries = this.sessionManager.getEntries();
			const settings = this.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			// Generate compaction result
			const result = await compact(
				pathEntries,
				model,
				modelApiKey,
				settings,
				this._compactionAbortController.signal,
			);
			const summary = result.summary;
			const firstKeptEntryId = result.firstKeptEntryId;
			const tokensBefore = result.tokensBefore;

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore);
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages.slice();

			return {
				summary,
				firstKeptEntryId,
				tokensBefore,
			};
		} finally {
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
		}
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;
		const model: Model<Api> | undefined = this.modelManager.find(this.providerName, this.modelName);
		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel = model && assistantMessage.provider === model.provider && assistantMessage.model === model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getEntries());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Overflow - LLM returned context overflow error
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", true);
		}

		// Case 2: Threshold - context is getting large
		// For error messages (no usage data), estimate from last successful response.
		// This ensures sessions that hit persistent API errors (e.g. 529) can still compact.
		let contextTokens: number;
		if (assistantMessage.stopReason === "error") {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = calculateContextTokens(assistantMessage.usage);
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();

		this._emit({ type: "compaction_start", reason });
		this._autoCompactionAbortController = new AbortController();
		const compactionRef = this.settingsManager.getCompactionModel();
		const compProvider = compactionRef?.provider ?? this.providerName;
		const compModel = compactionRef?.model ?? this.modelName;
		const model: Model<Api> | undefined = this.modelManager.find(compProvider, compModel);
		const modelApiKey = await this.modelManager.getApiKeyForProvider(compProvider);

		try {
			if (!model || !modelApiKey) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				return false;
			}

			const pathEntries = this.sessionManager.getEntries();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				return false;
			}

			// Generate compaction result
			const compactResult = await compact(
				pathEntries,
				model,
				modelApiKey,
				settings,
				this._autoCompactionAbortController.signal,
			);
			const summary = compactResult.summary;
			const firstKeptEntryId = compactResult.firstKeptEntryId;
			const tokensBefore = compactResult.tokensBefore;

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore);
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.getCompactionSettings().enabled = enabled;
	}
}
