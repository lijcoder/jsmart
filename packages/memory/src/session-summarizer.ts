import type { Api, Model } from "@jsmart/jsmart-ai";
import { completeSimple } from "@jsmart/jsmart-ai";
import type { SessionMessage } from "./types.js";

const MAX_SESSION_CHARS = 100_000;
const MAX_SUMMARY_TOKENS = 4096;

const SUMMARY_SYSTEM_PROMPT = `You are reviewing a past conversation transcript. Summarize it with focus on the search topic. Include:
1. What the user asked about or wanted to accomplish
2. What actions were taken and what the outcomes were
3. Key decisions, solutions found, or conclusions reached
4. Any specific commands, files, URLs, or technical details that were important
5. Anything left unresolved or notable

Be thorough but concise. Preserve specific details (commands, paths, error messages) that would be useful to recall. Write in past tense.`;

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatConversation(messages: SessionMessage[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		const role = msg.role.toUpperCase();
		const content = msg.content || "";

		if (msg.role === "toolResult" && msg.toolName) {
			// Truncate long tool outputs
			const truncated =
				content.length > 500 ? `${content.slice(0, 250)}\n...[truncated]...\n${content.slice(-250)}` : content;
			parts.push(`[TOOL:${msg.toolName}]: ${truncated}`);
		} else {
			parts.push(`[${role}]: ${content}`);
		}
	}
	return parts.join("\n\n");
}

function truncateAroundMatches(text: string, query: string, maxChars: number = MAX_SESSION_CHARS): string {
	if (text.length <= maxChars) return text;

	const textLower = text.toLowerCase();
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

	// Find match positions for each term
	const positions: number[] = [];
	for (const term of terms) {
		let idx = textLower.indexOf(term);
		while (idx !== -1) {
			positions.push(idx);
			idx = textLower.indexOf(term, idx + 1);
		}
	}

	if (positions.length === 0) {
		return `${text.slice(0, maxChars)}\n\n...[later conversation truncated]...`;
	}

	// Pick the window that covers the most match positions
	positions.sort((a, b) => a - b);
	let bestStart = 0;
	let bestCount = 0;
	for (const pos of positions) {
		const start = Math.max(0, pos - Math.floor(maxChars / 4));
		const end = start + maxChars;
		const count = positions.filter((p) => p >= start && p < end).length;
		if (count > bestCount) {
			bestCount = count;
			bestStart = start;
		}
	}

	const end = Math.min(text.length, bestStart + maxChars);
	const prefix = bestStart > 0 ? "...[earlier conversation truncated]...\n\n" : "";
	const suffix = end < text.length ? "\n\n...[later conversation truncated]..." : "";
	return prefix + text.slice(bestStart, end) + suffix;
}

function extractContent(response: { content: Array<{ type: string; text?: string }> }): string {
	const texts = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
	return texts;
}

// ── SessionSummarizer ───────────────────────────────────────────────────────

/**
 * Summarises past conversations using a cheap/fast LLM.
 *
 * The summarizer model should be fast and inexpensive (e.g. haiku) — its job
 * is to produce concise recaps so the main model doesn't need to read raw
 * transcripts that could be tens of thousands of tokens long.
 */
export class SessionSummarizer {
	constructor(
		private model: Model<Api>,
		private apiKey?: string,
		private maxChars: number = MAX_SESSION_CHARS,
	) {}

	/**
	 * Summarise a single session's conversation, focused on the search query.
	 */
	async summarize(
		messages: SessionMessage[],
		query: string,
		meta: { startedAt: string; source: string; model: string },
	): Promise<string> {
		let text = formatConversation(messages);
		text = truncateAroundMatches(text, query, this.maxChars);

		const prompt = [
			`Search topic: ${query}`,
			`Session source: ${meta.source}`,
			`Session date: ${meta.startedAt}`,
			"",
			"CONVERSATION TRANSCRIPT:",
			text,
			"",
			`Summarize this conversation with focus on: ${query}`,
		].join("\n");

		const response = await completeSimple(
			this.model,
			{
				systemPrompt: SUMMARY_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: MAX_SUMMARY_TOKENS, apiKey: this.apiKey },
		);

		if (response.stopReason === "error") {
			throw new Error(`Summarisation failed: ${response.errorMessage ?? "unknown error"}`);
		}

		return extractContent(response) || "";
	}

	/**
	 * Summarise multiple sessions in parallel.
	 */
	async summarizeAll(
		sessions: Array<{
			messages: SessionMessage[];
			query: string;
			meta: { startedAt: string; source: string; model: string };
		}>,
	): Promise<string[]> {
		const results = await Promise.allSettled(sessions.map((s) => this.summarize(s.messages, s.query, s.meta)));
		return results.map((r) => (r.status === "fulfilled" ? r.value : ""));
	}
}
