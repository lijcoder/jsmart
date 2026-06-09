import type { AgentTool } from "@jsmart/jsmart-agent-core";
import type { AgentSessionEvent } from "@jsmart/jsmart-harness";

// ── Output types ────────────────────────────────────────────────────

export interface JsonToolInfo {
	name: string;
	label: string;
	description: string;
}

export interface JsonSkillInfo {
	name: string;
	description: string;
}

export interface JsonMetadata {
	systemPrompt: string;
	model: string;
	workspace: string;
	tools: JsonToolInfo[];
	skills: JsonSkillInfo[];
}

export interface JsonRequest {
	prompt: string;
	timestamp: string;
}

export interface JsonToolCall {
	toolCallId: string;
	toolName: string;
	args: unknown;
	result: unknown;
	isError: boolean;
}

export interface JsonMessage {
	role: string;
	content: unknown;
	timestamp: number;
	/** Present on assistant messages. */
	stopReason?: string;
	/** Present on assistant messages. */
	usage?: unknown;
	/** Present on assistant messages. */
	errorMessage?: string;
	provider?: string;
	model?: string;
	/** Present on toolResult messages. */
	toolCallId?: string;
	/** Present on toolResult messages. */
	toolName?: string;
	/** Present on toolResult messages. */
	isError?: boolean;
}

export interface JsonTurn {
	index: number;
	messages: JsonMessage[];
	toolCalls: JsonToolCall[];
}

export interface JsonCompaction {
	reason: string;
	summary?: string;
	tokensBefore?: number;
	aborted: boolean;
	errorMessage?: string;
}

export interface JsonRetry {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
	success?: boolean;
	finalError?: string;
}

export interface JsonResult {
	result: string;
	status: "success" | "error" | "aborted";
	stopReason?: string;
	errorMessage?: string;
	usage?: unknown;
}

export interface JsonSessionOutput {
	metadata: JsonMetadata;
	request: JsonRequest;
	turns: JsonTurn[];
	compactions: JsonCompaction[];
	retries: JsonRetry[];
	result: JsonResult;
}

// ── Helpers ─────────────────────────────────────────────────────────

function findLast<T>(arr: T[], pred: (item: T) => boolean): T | undefined {
	for (let i = arr.length - 1; i >= 0; i--) {
		if (pred(arr[i])) return arr[i];
	}
	return undefined;
}

function sanitize(value: unknown): unknown {
	return JSON.parse(
		JSON.stringify(value, (_key, v) => {
			if (typeof v === "function") return undefined;
			if (typeof v === "symbol") return undefined;
			if (v === undefined) return null;
			return v;
		}),
	);
}

// ── Collector ───────────────────────────────────────────────────────

interface PendingToolCall {
	toolCallId: string;
	toolName: string;
	args: unknown;
}

export class JsonSessionCollector {
	private metadata!: JsonMetadata;
	private request!: JsonRequest;
	private turns: JsonTurn[] = [];
	private compactions: JsonCompaction[] = [];
	private retries: JsonRetry[] = [];
	private result: JsonResult = { result: "", status: "success" };

	private currentTurn: JsonTurn | null = null;
	private turnIndex = 0;
	private pendingToolCalls = new Map<string, PendingToolCall>();
	private pendingRetry: JsonRetry | null = null;

	setMetadata(params: {
		systemPrompt: string;
		model: string;
		workspace: string;
		tools: AgentTool<any, any>[];
		skills: { name: string; description: string }[];
	}): void {
		this.metadata = {
			systemPrompt: params.systemPrompt,
			model: params.model,
			workspace: params.workspace,
			tools: params.tools.map((t) => ({
				name: t.name,
				label: t.label,
				description: t.description,
			})),
			skills: params.skills.map((s) => ({
				name: s.name,
				description: s.description,
			})),
		};
	}

	setRequest(prompt: string): void {
		this.request = {
			prompt,
			timestamp: new Date().toISOString(),
		};
	}

	/** Feed an event to the collector. Accumulates state for final output. */
	feed(event: AgentSessionEvent): void {
		switch (event.type) {
			case "turn_start":
				this.ensureTurn();
				break;

			case "turn_end":
				if (this.currentTurn) {
					this.currentTurn.messages.push(toJsonMessage(event.message));
					if (event.toolResults) {
						for (const toolResult of event.toolResults) {
							this.currentTurn.messages.push(toJsonMessage(toolResult));
						}
					}
				}
				this.currentTurn = null;
				break;

			case "tool_execution_start":
				if (this.currentTurn) {
					this.pendingToolCalls.set(event.toolCallId, {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: sanitize(event.args),
					});
				}
				break;

			case "tool_execution_end":
				if (this.currentTurn) {
					const pending = this.pendingToolCalls.get(event.toolCallId);
					if (pending) {
						this.currentTurn.toolCalls.push({
							toolCallId: pending.toolCallId,
							toolName: pending.toolName,
							args: pending.args,
							result: sanitize(event.result),
							isError: event.isError,
						});
						this.pendingToolCalls.delete(event.toolCallId);
					}
				}
				break;

			case "agent_end": {
				const messages = event.messages;
				const raw = messages[messages.length - 1] as unknown as Record<string, unknown> | undefined;
				if (raw && raw.role === "assistant") {
					const reason = raw.stopReason as string | undefined;
					if (reason === "error" || reason === "aborted") {
						this.result.status = reason;
					}
					this.result.stopReason = reason;
					this.result.errorMessage = raw.errorMessage as string | undefined;
					this.result.usage = sanitize(raw.usage);
					this.result.result = extractAssistantText(raw.content);
				}
				break;
			}

			case "compaction_start":
				this.compactions.push({
					reason: event.reason,
					aborted: false,
				});
				break;

			case "compaction_end": {
				const compaction = findLast(this.compactions, (c) => c.reason === event.reason && c.summary === undefined);
				if (compaction) {
					compaction.summary = event.result?.summary;
					compaction.tokensBefore = event.result?.tokensBefore;
					compaction.aborted = event.aborted;
					compaction.errorMessage = event.errorMessage;
				}
				break;
			}

			case "auto_retry_start":
				this.pendingRetry = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				};
				break;

			case "auto_retry_end":
				if (this.pendingRetry) {
					this.pendingRetry.success = event.success;
					this.pendingRetry.finalError = event.finalError;
					this.retries.push(this.pendingRetry);
					this.pendingRetry = null;
				}
				break;
		}
	}

	/** Produce the final structured output. */
	finalize(): JsonSessionOutput {
		if (this.pendingRetry) {
			this.retries.push(this.pendingRetry);
			this.pendingRetry = null;
		}

		return {
			metadata: this.metadata,
			request: this.request,
			turns: this.turns,
			compactions: this.compactions,
			retries: this.retries,
			result: this.result,
		};
	}

	private ensureTurn(): void {
		if (!this.currentTurn) {
			this.currentTurn = {
				index: this.turnIndex++,
				messages: [],
				toolCalls: [],
			};
			this.turns.push(this.currentTurn);
		}
	}
}

// ── Message conversion ──────────────────────────────────────────────

/** Extract the final text from an assistant message's content array. */
function extractAssistantText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const texts = content
		.filter(
			(c): c is { type: string; text: string } =>
				typeof c === "object" &&
				c !== null &&
				"type" in c &&
				(c as { type: string }).type === "text" &&
				"text" in c,
		)
		.map((c) => c.text);
	return texts.join("\n");
}

function toJsonMessage(raw: unknown): JsonMessage {
	const msg = raw as Record<string, unknown>;
	const entry: JsonMessage = {
		role: (msg.role as string) ?? "unknown",
		content: sanitize(msg.content),
		timestamp: (msg.timestamp as number) ?? 0,
	};

	if (msg.role === "assistant") {
		entry.stopReason = msg.stopReason as string | undefined;
		entry.usage = sanitize(msg.usage);
		entry.errorMessage = msg.errorMessage as string | undefined;
		entry.provider = msg.provider as string | undefined;
		entry.model = msg.model as string | undefined;
	}

	if (msg.role === "toolResult") {
		entry.toolCallId = msg.toolCallId as string | undefined;
		entry.toolName = msg.toolName as string | undefined;
		entry.isError = msg.isError as boolean | undefined;
	}

	return entry;
}
