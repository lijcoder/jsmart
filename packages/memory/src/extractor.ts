import type { Api, Message, Model } from "@jsmart/jsmart-ai";
import { completeSimple } from "@jsmart/jsmart-ai";
import type { MemoryStore } from "./store.js";
import type { Memory, MemoryOperation } from "./types.js";

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant for an AI agent system. Your job is to analyze recent conversations and decide what facts are worth remembering long-term across future sessions.

You receive:
1. A list of existing memories (may be empty)
2. A recent conversation excerpt

You must respond with a valid JSON array of memory operations. Each operation has an "op" field:
- "create": A new fact not covered by existing memories
- "update": Refine or correct an existing memory (provide the exact "name" field to update)
- "delete": An existing memory is now outdated or wrong (provide "name" and "reason")
- "skip": No operation needed — use this when there is nothing worth saving

Rules:
- Save ONLY facts valuable across sessions: user preferences, project constraints, architecture decisions, coding conventions, learned patterns
- Do NOT save: current task status, transient values, small talk, information already covered by existing memories
- Merge semantically similar facts — do not create duplicates
- When facts contradict, trust the most recent conversation
- Memory names must be kebab-case slugs (e.g. "user-lang-pref", "project-tech-stack")
- Keep content concise and actionable; include "**Why:**" and "**How to apply:**" lines

Example output:
[
  {
    "op": "create",
    "name": "user-lang-pref",
    "description": "User prefers Chinese responses and code comments",
    "type": "user",
    "content": "User explicitly requested all replies in Chinese, including code comments.\\n\\n**Why:** User corrected English output multiple times.\\n**How to apply:** Always respond in Chinese; write code comments in Chinese."
  },
  { "op": "skip" }
]`;

function extractText(msg: Message): string | null {
	if (msg.role === "user") {
		// content may be a plain string or an array
		if (typeof msg.content === "string") return msg.content.trim() || null;
		const text = msg.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" ")
			.trim();
		return text || null;
	}

	if (msg.role === "assistant") {
		// filter out tool calls and thinking blocks
		const text = msg.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" ")
			.trim();
		return text || null;
	}

	// toolResult messages — skip
	return null;
}

function formatMessagesForExtraction(messages: Message[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		const text = extractText(msg);
		if (!text) continue;
		const prefix = msg.role === "user" ? "User" : "Assistant";
		parts.push(`${prefix}: ${text}`);
	}
	return parts.join("\n\n");
}

function formatExistingMemories(memories: Memory[]): string {
	if (memories.length === 0) return "(none)";
	return memories.map((m) => `### ${m.name}\n_${m.description}_\n\n${m.content}`).join("\n\n---\n\n");
}

function extractFirstJsonArray(text: string): string | null {
	// Walk character-by-character to find the first complete [...] balanced block.
	// A greedy regex like /\[[\s\S]*\]/ would match from the first '[' all the way to
	// the *last* ']' in the string, causing JSON.parse to fail whenever the LLM appends
	// Markdown links or explanatory text after the JSON array.
	const start = text.indexOf("[");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && inString) {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "[") depth++;
		else if (ch === "]") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function parseOperations(responseText: string): MemoryOperation[] {
	const jsonArray = extractFirstJsonArray(responseText);
	if (!jsonArray) return [];
	try {
		const parsed = JSON.parse(jsonArray);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(op): op is MemoryOperation =>
				op && typeof op === "object" && ["create", "update", "delete", "skip"].includes(op.op),
		);
	} catch {
		return [];
	}
}

/** LLM-based background memory extractor. Internal use only. */
export class MemoryExtractor {
	constructor(
		private store: MemoryStore,
		private model: Model<Api>,
		private apiKey?: string,
	) {}

	/**
	 * Extracts memories from the given messages and applies the resulting operations.
	 * Only user/assistant text is considered; tool calls and thinking blocks are ignored.
	 */
	async extract(newMessages: Message[]): Promise<void> {
		const conversationText = formatMessagesForExtraction(newMessages);
		if (!conversationText.trim()) return;

		const existing = this.store.readAll();

		const prompt = [
			"## Existing Memories",
			"",
			formatExistingMemories(existing),
			"",
			"## Recent Conversation",
			"",
			conversationText,
			"",
			"Return a JSON array of memory operations based on the above.",
		].join("\n");

		const response = await completeSimple(
			this.model,
			{
				systemPrompt: EXTRACTION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: 2048, apiKey: this.apiKey },
		);

		if (response.stopReason === "error") {
			throw new Error(`Memory extraction LLM call failed: ${response.errorMessage ?? "unknown error"}`);
		}

		const responseText = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		const ops = parseOperations(responseText);
		const now = new Date().toISOString();
		this.store.applyOperations(ops, now);
	}
}
