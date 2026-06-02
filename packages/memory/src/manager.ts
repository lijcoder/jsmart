import type { Message } from "@jsmart/jsmart-ai";
import { MemoryExtractor } from "./extractor.js";
import { MemoryLoader } from "./loader.js";
import { MemoryStore } from "./store.js";
import type { Memory, MemoryManagerOptions } from "./types.js";

/**
 * Orchestrates persistent memory for an agent session.
 *
 * This class only depends on `@jsmart/jsmart-ai` — it is not coupled to any
 * agent framework. Upper layers (e.g. harness, coding-agent) are responsible
 * for wiring the hooks and creating framework-specific tools.
 *
 * Usage:
 * ```ts
 * const mem = new MemoryManager({ memoryDir, extractionModel, extractionApiKey });
 * mem.ensureDir();
 *
 * // Inject into system prompt at session start
 * const memBlock = mem.formatForPrompt(); // null if no memories yet
 *
 * // Trigger extraction (upper layer controls timing/interval)
 * mem.generalMemory(messages);
 *
 * // Search is exposed for upper layers to build tools on top of
 * mem.search("user preferences");
 * ```
 */
export class MemoryManager {
	private readonly store: MemoryStore;
	private readonly loader: MemoryLoader;
	private readonly extractor: MemoryExtractor;

	constructor(options: MemoryManagerOptions) {
		this.store = new MemoryStore(options.memoryDir);
		this.loader = new MemoryLoader(this.store);
		this.extractor = new MemoryExtractor(this.store, options.extractionModel, options.extractionApiKey);
	}

	/** Ensures the memory directory exists. Call once at session start. */
	ensureDir(): void {
		this.store.ensureDir();
	}

	/**
	 * Returns a markdown block describing the memory index for injection into
	 * the agent system prompt. Returns null when there are no memories yet.
	 */
	formatForPrompt(): string | null {
		return this.loader.formatForPrompt();
	}

	/**
	 * Trigger background extraction on the given messages.
	 * The upper layer is responsible for batching and timing — this method
	 * fires extraction immediately on every call.
	 *
	 * @param messages - Messages to extract memories from
	 */
	generalMemory(messages: Message[]): void {
		this._triggerExtraction(messages);
	}

	/**
	 * Keyword search across all memories (name, description, content).
	 * Splits the query into whitespace-separated tokens and requires ALL tokens
	 * to match somewhere in the memory (AND logic). Case-insensitive.
	 *
	 * Example: query "中文 语言 偏好" matches a memory containing all three
	 * words "中文", "语言", "偏好" anywhere in its text.
	 */
	search(query: string): Memory[] {
		const tokens = query
			.trim()
			.split(/\s+/)
			.map((t) => t.toLowerCase());
		if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "")) return [];

		return this.store.readAll().filter((m) => {
			const haystack = `${m.name} ${m.description} ${m.content}`.toLowerCase();
			return tokens.every((token) => haystack.includes(token));
		});
	}

	// ── private ────────────────────────────────────────────────────────────────

	private _triggerExtraction(messages: Message[]): void {
		if (messages.length === 0) {
			return;
		}

		this.extractor.extract(messages).catch((err: Error) => {
			console.warn("[memory] Background extraction failed:", err.message);
		});
	}
}
