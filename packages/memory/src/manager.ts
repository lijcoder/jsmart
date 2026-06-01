import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@jsmart/jsmart-agent-core";
import { MemoryExtractor } from "./extractor.js";
import { MemoryLoader } from "./loader.js";
import { MemoryStore } from "./store.js";
import { createMemoryTools } from "./tools.js";
import type { Memory, MemoryManagerOptions, MemoryState } from "./types.js";

const DEFAULT_EXTRACTION_INTERVAL = 5;
const STATE_FILENAME = ".state.json";
const EMPTY_STATE: MemoryState = { lastExtractedMessageIndex: 0, lastExtractedAt: "" };

/**
 * Orchestrates persistent memory for an agent session.
 *
 * Usage:
 * ```ts
 * const mem = new MemoryManager({ memoryDir, extractionModel });
 * mem.ensureDir();
 *
 * // Inject into system prompt at session start
 * const memBlock = mem.formatForPrompt(); // null if no memories yet
 *
 * // Add the read-only search tool
 * const tools = [...existingTools, ...mem.getTools()];
 *
 * // Hook into session events
 * session.subscribe((event) => {
 *   if (event.type === "agent_end")       mem.onTurnEnd(event.messages);
 *   if (event.type === "compaction_start") mem.onBeforeCompaction(session.messages);
 * });
 * ```
 */
export class MemoryManager {
	private readonly store: MemoryStore;
	private readonly loader: MemoryLoader;
	private readonly extractor: MemoryExtractor | undefined;
	private readonly memoryDir: string;
	private state: MemoryState;
	private turnCount = 0;
	private readonly extractionInterval: number;

	constructor(options: MemoryManagerOptions) {
		this.memoryDir = options.memoryDir;
		this.store = new MemoryStore(options.memoryDir);
		this.loader = new MemoryLoader(this.store);
		this.extractionInterval = options.extractionInterval ?? DEFAULT_EXTRACTION_INTERVAL;
		if (options.extractionModel) {
			this.extractor = new MemoryExtractor(this.store, options.extractionModel);
		}
		this.state = this._loadState();
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
	 * Call after each agent turn (subscribe to `agent_end` event).
	 * Triggers background extraction every `extractionInterval` turns.
	 */
	onTurnEnd(allMessages: AgentMessage[]): void {
		this.turnCount++;
		if (this.turnCount % this.extractionInterval === 0) {
			this._triggerExtraction(allMessages);
		}
	}

	/**
	 * Call before context compaction (subscribe to `compaction_start` event).
	 * Extracts memories from new messages so they are not lost during compaction.
	 * Only processes messages since the last extraction — no double-processing.
	 */
	onBeforeCompaction(allMessages: AgentMessage[]): void {
		this._triggerExtraction(allMessages);
	}

	/**
	 * Keyword search across all memories (name, description, content).
	 * Case-insensitive.
	 */
	search(query: string): Memory[] {
		const q = query.toLowerCase();
		return this.store
			.readAll()
			.filter(
				(m) => m.name.includes(q) || m.description.toLowerCase().includes(q) || m.content.toLowerCase().includes(q),
			);
	}

	/** Returns the read-only agent tools (memory_search only). */
	getTools(): AgentTool<any>[] {
		return createMemoryTools(this);
	}

	// ── private ────────────────────────────────────────────────────────────────

	private _triggerExtraction(allMessages: AgentMessage[]): void {
		if (!this.extractor) return;

		const newMessages = allMessages.slice(this.state.lastExtractedMessageIndex);
		if (newMessages.length === 0) return;

		// Capture current length so the state update is consistent even if
		// more messages arrive while extraction is in flight.
		const extractedUpTo = allMessages.length;

		this.extractor
			.extract(newMessages)
			.then(() => {
				this.state.lastExtractedMessageIndex = extractedUpTo;
				this.state.lastExtractedAt = new Date().toISOString();
				this._saveState();
			})
			.catch((err: Error) => {
				console.warn("[memory] Background extraction failed:", err.message);
			});
	}

	private _loadState(): MemoryState {
		const stateFile = join(this.memoryDir, STATE_FILENAME);
		if (!existsSync(stateFile)) return { ...EMPTY_STATE };
		try {
			return JSON.parse(readFileSync(stateFile, "utf-8")) as MemoryState;
		} catch {
			return { ...EMPTY_STATE };
		}
	}

	private _saveState(): void {
		const stateFile = join(this.memoryDir, STATE_FILENAME);
		try {
			writeFileSync(stateFile, JSON.stringify(this.state, null, 2), "utf-8");
		} catch (err) {
			console.warn("[memory] Failed to save state:", (err as Error).message);
		}
	}
}
