import type { AgentTool, StreamFn } from "@jsmart/jsmart-agent-core";
import { Agent, type AgentEvent } from "@jsmart/jsmart-agent-core";
import type { Api, AssistantMessage, Model } from "@jsmart/jsmart-ai";
import { isContextOverflow } from "@jsmart/jsmart-ai";
import { compact, DEFAULT_COMPACTION_SETTINGS, estimateTotalTokens, shouldCompact } from "./compaction.js";
import { createExecutor } from "./executor.js";
import { convertToLlm } from "./messages.js";
import type { ModelManager } from "./model-manager.js";
import { buildSystemPrompt } from "./prompts.js";
import type { ResourceLoader } from "./resource-manager.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import { createTools } from "./tools/index.js";
import { sleep } from "./utils/sleep.js";

export interface ResultState<T> {
	isSuccess: boolean;
	error?: string;
	result?: T;
}
/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| AgentEvent
	| { type: "slash_command"; name: string; message: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent, signal?: AbortSignal) => void;

export interface AgentSessionOptions {
	/** 自定义提示词模板 */
	promptTemplate?: string;
	/** 自定义内容，替换 {{custom}} 占位符 */
	customContent?: string | (() => string);
	/** Additional tools to append to the default tool set */
	additionalTools?: AgentTool<any>[];
	streamFn?: StreamFn;
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
	// Event subscription state
	// private _unsubscribeAgent?: () => void;

	private _eventListeners: AgentSessionEventListener[] = [];
	private _agentEventQueue: Promise<void> = Promise.resolve();

	// Compaction state
	private _overflowRecoveryAttempted = false;
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	// Retry state
	private _retryAttempt = 0;
	private _retryAbortController: AbortController | undefined = undefined;

	constructor(
		workspace: string,
		settingsManager: SettingsManager,
		sessionManager: SessionManager,
		resourceLoader: ResourceLoader,
		modelManager: ModelManager,
		providerName: string,
		modelName: string,
		options?: AgentSessionOptions,
	) {
		this.workspace = workspace;
		this.settingsManager = settingsManager;
		this.sessionManager = sessionManager;
		this.resourceLoader = resourceLoader;
		this.modelManager = modelManager;
		this.providerName = providerName;
		this.modelName = modelName;
		const model: Model<Api> | undefined = this.modelManager.find(this.providerName, this.modelName);
		const { messages } = this.sessionManager.buildSessionContext();
		this.agent = new Agent({
			initialState: {
				model: model,
				thinkingLevel: "medium",
				messages: messages,
			},
			toolExecution: "sequential",
			getApiKey: async (provider) => {
				return this.modelManager.getApiKeyForProvider(provider);
			},
			streamFn: options?.streamFn,
			convertToLlm: convertToLlm,
		});
		const executor = createExecutor();
		const tools = createTools(executor);
		if (options?.additionalTools) {
			tools.push(...options.additionalTools);
		}
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
		this.agent.subscribe(this._handleAgentEvent);
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
			const msg = `Context tokens: ${this.getContextTokens()}`;
			this._emit({ type: "slash_command", name: "tokens", message: msg });
			return true;
		}
		return false;
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {}

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
			return { isSuccess: true };
		}
	}

	getAllModelName(): string[] {
		const modelNames = [];
		for (const m of this.modelManager.getAll()) {
			modelNames.push(`${m.provider}/${m.id}`);
		}
		return modelNames;
	}

	getSessionFilePath(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Get current context token count */
	getContextTokens(): number {
		return estimateTotalTokens(this.agent.state.messages);
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
	// Auto-Compact
	// =========================================================================

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled)
		if (assistantMessage.stopReason === "aborted") return false;

		const model = this.agent.state.model;
		if (!model) return false;

		const contextWindow = model.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model
		const sameModel = assistantMessage.provider === model.provider && assistantMessage.model === model.id;

		// Case 1: Overflow - LLM returned context overflow error
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			if (this._overflowRecoveryAttempted) {
				console.error("Context overflow recovery failed after one compact-and-retry attempt.");
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			await this._runAutoCompaction("overflow", true);
			return true;
		}

		// Case 2: Threshold - context is getting large
		// For error messages (no usage data), skip compaction
		if (assistantMessage.stopReason === "error") {
			return false;
		}

		const contextTokens =
			assistantMessage.usage?.totalTokens ??
			(assistantMessage.usage ? assistantMessage.usage.input + assistantMessage.usage.output : 0);

		if (shouldCompact(contextTokens, contextWindow, settings)) {
			await this._runAutoCompaction("threshold", false);
			return true;
		}
		return false;
	}

	/**
	 * Internal: Run auto-compaction with optional auto-retry.
	 * Reuses runCompaction() for the actual compaction work.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<void> {
		const result = await this.runCompaction();

		if (!result.isSuccess) {
			console.error(`Auto-compaction failed (${reason}): ${result.error}`);
			return;
		}

		console.log(`Auto-compaction completed (${reason}). Summary: ${result.result!.summary.slice(0, 100)}...`);

		if (willRetry) {
			// Remove error message if present and retry
			const messages = this.agent.state.messages;
			const lastMsg = messages[messages.length - 1];
			if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			// Retry after a short delay
			setTimeout(() => {
				this.agent.continue().catch(() => {});
			}, 100);
		}
	}

	/** Run compaction and return result */
	async runCompaction(): Promise<ResultState<{ summary: string; tokensBefore: number }>> {
		const model = this.modelManager.find(this.providerName, this.modelName);
		if (!model) {
			return { isSuccess: false, error: "Model not found" };
		}

		const apiKey = await this.modelManager.getApiKeyForProvider(this.providerName);
		if (!apiKey) {
			return { isSuccess: false, error: "API key not found" };
		}

		const entries = this.sessionManager.getEntries();

		try {
			const result = await compact(entries, model, apiKey, DEFAULT_COMPACTION_SETTINGS);

			// Append compaction entry
			this.sessionManager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore);

			// Reload session context
			const { messages } = this.sessionManager.buildSessionContext();
			this.agent.state.messages = messages;

			return {
				isSuccess: true,
				result: { summary: result.summary, tokensBefore: result.tokensBefore },
			};
		} catch (error) {
			return {
				isSuccess: false,
				error: error instanceof Error ? error.message : "Compaction failed",
			};
		}
	}
}
