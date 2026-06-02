import { join } from "node:path";
import type { Message } from "@jsmart/jsmart-ai";
import { MemoryExtractor } from "./extractor.js";
import { MemoryLoader } from "./loader.js";
import { MemorySearchIndex } from "./search-index.js";
import { MemoryStore } from "./store.js";
import type { Memory, MemoryManagerOptions, MemorySearchResult } from "./types.js";

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
 * // Keyword search (original, unchanged)
 * mem.search("user preferences");
 *
 * // FTS5 BM25 search with line citations (new)
 * mem.hybridSearch("user preferences");
 * ```
 */
export class MemoryManager {
	private readonly store: MemoryStore;
	private readonly loader: MemoryLoader;
	private readonly extractor: MemoryExtractor;
	private readonly memoryDir: string;
	/** Lazy-initialised in ensureDir(). */
	private searchIndex?: MemorySearchIndex;

	constructor(options: MemoryManagerOptions) {
		this.memoryDir = options.memoryDir;
		this.store = new MemoryStore(options.memoryDir);
		this.loader = new MemoryLoader(this.store);
		this.extractor = new MemoryExtractor(this.store, options.extractionModel, options.extractionApiKey);
	}

	/**
	 * Ensures the memory directory exists and initialises the search index.
	 * Must be called once at session start before any search or extraction.
	 */
	ensureDir(): void {
		this.store.ensureDir();

		// Initialise SQLite FTS5 search index (stored alongside memory files)
		const dbPath = join(this.memoryDir, "search.db");
		this.searchIndex = new MemorySearchIndex(dbPath);

		// Warm the index with any memories written in a previous session
		const existing = this.store.readAll();
		if (existing.length > 0) {
			this.searchIndex.reindex(existing);
		}
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

	/**
	 * FTS5 BM25-ranked search — returns chunks with relevance scores and
	 * line-level citations (e.g. `user-lang-pref.md#L9-L15`).
	 *
	 * Unlike `search()` this method:
	 * - Ranks results by relevance (not just match/no-match)
	 * - Returns snippets (sub-file chunks) instead of full memory content
	 * - Includes file + line citations for traceability
	 *
	 * Requires `ensureDir()` to have been called. If the search index is not
	 * yet initialised (e.g. in tests that skip ensureDir), falls back to
	 * wrapping `search()` results as MemorySearchResult objects.
	 *
	 * @param query      Natural-language search query.
	 * @param opts.maxResults  Max results to return (default 8).
	 */
	hybridSearch(query: string, opts?: { maxResults?: number }): MemorySearchResult[] {
		if (this.searchIndex) {
			return this.searchIndex.search(query, opts);
		}

		// Fallback: wrap classic search() results as MemorySearchResult
		return this.search(query).map((m) => ({
			name: m.name,
			description: m.description,
			startLine: 9, // content starts after the 8-line frontmatter
			endLine: 9 + m.content.split("\n").length - 1,
			score: 0.5,
			snippet: m.content,
			citation: `${m.name}.md`,
		}));
	}

	// ── private ────────────────────────────────────────────────────────────────

	private _triggerExtraction(messages: Message[]): void {
		if (messages.length === 0) {
			return;
		}

		this.extractor
			.extract(messages)
			.then(() => {
				// Sync the FTS index to reflect newly written/updated/deleted memories
				if (this.searchIndex) {
					this.searchIndex.reindex(this.store.readAll());
				}
			})
			.catch((err: Error) => {
				console.warn("[memory] Background extraction failed:", err.message);
			});
	}
}
