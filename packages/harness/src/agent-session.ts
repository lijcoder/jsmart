import { Agent, type AgentEvent } from "@jsmart/jsmart-agent-core";
import type { Api, AssistantMessage, Model } from "@jsmart/jsmart-ai";
import { isContextOverflow } from "@jsmart/jsmart-ai";
import { compact, DEFAULT_COMPACTION_SETTINGS, estimateTotalTokens, shouldCompact } from "./compaction.js";
import { createExecutor } from "./executor.js";
import type { ModelManager } from "./model-manager.js";
import { buildSystemPrompt } from "./prompts.js";
import type { ResourceLoader } from "./resource-manager.js";
import type { SessionManager } from "./session-manager.js";
import { createTools } from "./tools/index.js";

export interface ResultState<T> {
	isSuccess: boolean;
	error?: string;
	result?: T;
}
/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent = AgentEvent;

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

export interface AgentSessionOptions {
	/** 自定义提示词模板 */
	promptTemplate?: string;
	/** 自定义内容，替换 {{custom}} 占位符 */
	customContent?: string | (() => string);
}

export class AgentSession {
	private sessionManager: SessionManager;
	private resourceLoader: ResourceLoader;

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

	constructor(
		workspace: string,
		sessionManager: SessionManager,
		resourceLoader: ResourceLoader,
		modelManager: ModelManager,
		providerName: string,
		modelName: string,
		options?: AgentSessionOptions,
	) {
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
		});
		const executor = createExecutor();
		const tools = createTools(executor);
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
		console.log(this.agent.state.systemPrompt);
		this.agent.subscribe(this._handleAgentEvent);
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = (event: AgentEvent): void => {
		this._agentEventQueue = this._agentEventQueue.then(
			() => this._processAgentEvent(event),
			() => this._processAgentEvent(event),
		);

		// Keep queue alive if an event handler fails
		this._agentEventQueue.catch(() => {});
	};

	private async _processAgentEvent(event: AgentEvent): Promise<void> {
		// Notify all listeners
		this._emit(event);

		// Handle session persistence
		if (event.type === "message_end") {
			if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message as AssistantMessage;
				if ((event.message as AssistantMessage).stopReason !== "error") {
					this._overflowRecoveryAttempted = false;
				}
			}
		}

		// Check auto-compaction after agent completes
		if (event.type === "agent_end" && this._lastAssistantMessage) {
			const msg = this._lastAssistantMessage;
			this._lastAssistantMessage = undefined;
			await this._checkCompaction(msg);
		}
	}

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
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
		// Wait for the agent to finish processing any current prompt before sending a new one
		await this.agent.waitForIdle();
		await this.agent.prompt(text);
	}

	messageCount(): number {
		return this.agent.state.messages.length;
	}

	getModelName(): string {
		return `${this.providerName}/${this.modelName}`;
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

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage): Promise<void> {
		const settings = DEFAULT_COMPACTION_SETTINGS;
		if (!settings.enabled) return;

		// Skip if message was aborted (user cancelled)
		if (assistantMessage.stopReason === "aborted") return;

		const model = this.agent.state.model;
		if (!model) return;

		const contextWindow = model.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model
		const sameModel = assistantMessage.provider === model.provider && assistantMessage.model === model.id;

		// Case 1: Overflow - LLM returned context overflow error
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			if (this._overflowRecoveryAttempted) {
				console.error("Context overflow recovery failed after one compact-and-retry attempt.");
				return;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			await this._runAutoCompaction("overflow", true);
			return;
		}

		// Case 2: Threshold - context is getting large
		// For error messages (no usage data), skip compaction
		if (assistantMessage.stopReason === "error") {
			return;
		}

		const contextTokens =
			assistantMessage.usage?.totalTokens ??
			(assistantMessage.usage ? assistantMessage.usage.input + assistantMessage.usage.output : 0);

		if (shouldCompact(contextTokens, contextWindow, settings)) {
			await this._runAutoCompaction("threshold", false);
		}
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
