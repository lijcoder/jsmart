/**
 * Context compaction for harness sessions.
 *
 * When context exceeds threshold, old messages are summarized by LLM
 * and replaced with a compaction entry.
 */

import type { AgentMessage } from "@jsmart/jsmart-agent-core";
import type { Api, Message, Model } from "@jsmart/jsmart-ai";
import { completeSimple } from "@jsmart/jsmart-ai";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "./session-manager.js";

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16000,
	keepRecentTokens: 20000,
};

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Whether this is a split turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

export interface CompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

// ============================================================================
// Token estimation
// ============================================================================

/**
 * Estimate token count for a message using chars/4 heuristic.
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	// Check if message has a role property (standard Message types)
	if (!("role" in message)) {
		return 0;
	}

	switch (message.role) {
		case "user": {
			const content = message.content;
			if (typeof content === "string") {
				chars = content.length;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			for (const block of message.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "toolResult": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				chars = content.length;
			} else {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		default:
			return 0;
	}
}

/**
 * Estimate total tokens for all messages.
 */
export function estimateTotalTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		total += estimateTokens(msg);
	}
	return total;
}

/**
 * Check if compaction should trigger.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// Cut point detection
// ============================================================================

/**
 * Find valid cut points: indices of user or assistant messages.
 * Never cut at tool results (they must follow their tool call).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "assistant") {
				cutPoints.push(i);
			}
		}
	}
	return cutPoints;
}

/**
 * Find the user message that starts the turn containing the given entry index.
 */
function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message.role === "user") {
			return i;
		}
	}
	return -1;
}

/**
 * Find the cut point that keeps approximately `keepRecentTokens`.
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		const messageTokens = estimateTokens(entry.message);
		accumulatedTokens += messageTokens;

		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			for (const cp of cutPoints) {
				if (cp >= i) {
					cutIndex = cp;
					break;
				}
			}
			break;
		}
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex] as SessionMessageEntry;
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_SYSTEM_PROMPT = `You are a helpful assistant that creates structured summaries of conversations.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Important information needed to continue]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are a continuation of a conversation. Below is the previous context summary.

<previous_summary>
{{PREVIOUS_SUMMARY}}
</previous_summary>

Update the summary to incorporate the new messages. Maintain the same structured format, preserving relevant information from the previous summary while adding new developments.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Important information needed to continue]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Serialize messages to text for summarization.
 */
function serializeMessages(messages: AgentMessage[]): string {
	const lines: string[] = [];
	for (const msg of messages) {
		if (!("role" in msg)) continue;

		if (msg.role === "user") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c) => c.type === "text")
							.map((c) => (c as any).text || "")
							.join("\n");
			lines.push(`[User]: ${text}`);
		} else if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "text") {
					lines.push(`[Assistant]: ${block.text}`);
				} else if (block.type === "toolCall") {
					lines.push(`[Tool Call: ${block.name}]: ${JSON.stringify(block.arguments)}`);
				}
			}
		} else if (msg.role === "toolResult") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c) => c.type === "text")
							.map((c) => (c as any).text || "")
							.join("\n");
			lines.push(`[Tool Result: ${msg.toolName}]: ${text}`);
		}
	}
	return lines.join("\n\n");
}

/**
 * Generate a summary using LLM.
 * If previousSummary is provided, updates it with new messages instead of creating from scratch.
 */
export async function generateSummary(
	messages: AgentMessage[],
	model: Model<Api>,
	apiKey: string,
	reserveTokens: number,
	signal?: AbortSignal,
	previousSummary?: string,
): Promise<string> {
	const maxTokens = Math.floor(0.8 * reserveTokens);
	const conversationText = serializeMessages(messages);

	const promptText = previousSummary
		? `<conversation>\n${conversationText}\n</conversation>\n\n${UPDATE_SUMMARIZATION_PROMPT.replace("{{PREVIOUS_SUMMARY}}", previousSummary)}`
		: `<conversation>\n${conversationText}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`;

	const summarizationMessages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		{ maxTokens, signal, apiKey },
	);

	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return textContent;
}

// ============================================================================
// Main compaction function
// ============================================================================

/**
 * Prepare compaction data from session entries.
 * Returns previous summary if exists, allowing cumulative compaction.
 */
export function prepareCompaction(
	entries: SessionEntry[],
	settings: CompactionSettings,
): {
	messagesToSummarize: AgentMessage[];
	firstKeptEntryIndex: number;
	firstKeptEntryId: string;
	tokensBefore: number;
	previousSummary?: string;
} | null {
	if (entries.length === 0) return null;

	// Find previous compaction and its boundary
	let startIndex = 0;
	let previousSummary: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			const compaction = entries[i] as CompactionEntry;
			previousSummary = compaction.summary;
			const firstKeptIdx = entries.findIndex((e) => e.id === compaction.firstKeptEntryId);
			startIndex = firstKeptIdx >= 0 ? firstKeptIdx : i + 1;
			break;
		}
	}

	const tokensBefore = estimateTotalTokens(
		entries.filter((e) => e.type === "message").map((e) => (e as SessionMessageEntry).message),
	);

	const cutPoint = findCutPoint(entries, startIndex, entries.length, settings.keepRecentTokens);
	const firstKeptEntry = entries[cutPoint.firstKeptEntryIndex];

	if (!firstKeptEntry?.id) {
		return null;
	}

	// Collect messages to summarize
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = startIndex; i < cutPoint.firstKeptEntryIndex; i++) {
		const entry = entries[i];
		if (entry.type === "message") {
			messagesToSummarize.push(entry.message);
		}
	}

	return {
		messagesToSummarize,
		firstKeptEntryIndex: cutPoint.firstKeptEntryIndex,
		firstKeptEntryId: firstKeptEntry.id,
		tokensBefore,
		previousSummary,
	};
}

/**
 * Compact session entries using LLM summarization.
 */
export async function compact(
	entries: SessionEntry[],
	model: Model<Api>,
	apiKey: string,
	settings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS,
	signal?: AbortSignal,
): Promise<CompactionResult> {
	const preparation = prepareCompaction(entries, settings);

	if (!preparation) {
		throw new Error("Cannot compact: no entries or invalid session");
	}

	const { messagesToSummarize, firstKeptEntryId, tokensBefore, previousSummary } = preparation;

	if (messagesToSummarize.length === 0) {
		throw new Error("No messages to summarize");
	}

	const summary = await generateSummary(
		messagesToSummarize,
		model,
		apiKey,
		settings.reserveTokens,
		signal,
		previousSummary,
	);

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
	};
}
