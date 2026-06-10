import { join } from "node:path";
import type { Message } from "@jsmart/jsmart-ai";
import { MemoryStore } from "./memory-store.js";
import { SessionStore } from "./session-store.js";
import { SessionSummarizer } from "./session-summarizer.js";
import type {
	MemoryManagerOptions,
	MemoryResult,
	MemoryTarget,
	SessionMessage,
	SessionSearchOptions,
	SessionSearchResult,
} from "./types.js";

/**
 * Hermes-style memory manager with frozen-snapshot semantics.
 *
 * - MEMORY.md + USER.md with § delimiter, always in system prompt (frozen snapshot).
 * - LLM calls the `memory` tool (add/replace/remove) directly.
 * - Nudge background review every N turns (default 10) for passive memory capture.
 * - session_search for cross-session conversation recall (SQLite FTS5 + Jieba).
 */
export class MemoryManager {
	private readonly store: MemoryStore;
	private readonly memoryDir: string;
	private readonly userId: string;
	private readonly projectId?: string;
	private sessionStore?: SessionStore;
	private summarizer: SessionSummarizer;

	constructor(options: MemoryManagerOptions) {
		this.userId = options.userId;
		this.projectId = options.projectId;

		// User-scoped directory: {memoryDir}/{userId}/
		const userDir = join(options.memoryDir, options.userId);
		this.memoryDir = userDir;

		this.store = new MemoryStore(userDir, options.memoryCharLimit ?? 2200, options.userCharLimit ?? 1375);

		this.summarizer = new SessionSummarizer(options.summarizationModel, options.summarizationApiKey);
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	ensureDir(): void {
		this.store.ensureDir();
		this.store.loadFromDisk();

		const sessionsDbPath = join(this.memoryDir, "sessions.db");
		this.sessionStore = new SessionStore(sessionsDbPath);
	}

	// ── System prompt (frozen snapshot) ────────────────────────────────────

	/**
	 * Returns the memory + user profile blocks for system prompt injection.
	 * Uses the frozen snapshot — stable across the entire session for prefix caching.
	 */
	formatForPrompt(): string | null {
		const parts: string[] = [];
		const mem = this.store.formatForSystemPrompt("memory");
		const usr = this.store.formatForSystemPrompt("user");
		if (mem) parts.push(mem);
		if (usr) parts.push(usr);
		return parts.length > 0 ? parts.join("\n\n") : null;
	}

	// ── Memory tool ───────────────────────────────────────────────────────

	add(target: MemoryTarget, content: string): MemoryResult {
		return this.store.add(target, content);
	}

	replace(target: MemoryTarget, oldText: string, newContent: string): MemoryResult {
		return this.store.replace(target, oldText, newContent);
	}

	remove(target: MemoryTarget, oldText: string): MemoryResult {
		return this.store.remove(target, oldText);
	}

	// ── Session search (unchanged from P0-P2) ─────────────────────────────

	sessionSearch(opts: SessionSearchOptions = {}): SessionSearchResult[] {
		if (!this.sessionStore) return [];
		return this.sessionStore.search(opts);
	}

	async sessionSearchAsync(opts: SessionSearchOptions = {}): Promise<SessionSearchResult[]> {
		const results = this.sessionSearch(opts);
		if (opts.query && results.length > 0) {
			await this._summarizeAsync(results, opts.query);
		}
		return results;
	}

	insertSessionMessages(sessionId: string, source: string, model: string, messages: Message[]): void {
		if (!this.sessionStore) return;
		const now = Date.now() / 1000;
		const sms: SessionMessage[] = [];
		for (const msg of messages) {
			if (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult") {
				let content: string;
				if (typeof msg.content === "string") {
					content = msg.content;
				} else {
					// Extract text + tool call names for searchable content
					const parts: string[] = [];
					for (const c of msg.content) {
						if (c.type === "text" && c.text) parts.push(c.text);
						else if (c.type === "toolCall" && "name" in c) parts.push(`[TOOL:${(c as any).name}]`);
					}
					content = parts.join(" ").trim();
				}
				if (content) {
					sms.push({ id: 0, sessionId, role: msg.role, content, timestamp: msg.timestamp ?? now * 1000 });
				}
			}
		}
		if (sms.length > 0) {
			this.sessionStore.upsertSession({
				id: sessionId,
				source,
				model,
				startedAt: now,
				lastActive: now,
				messageCount: sms.length,
				userId: this.userId,
				projectId: this.projectId,
			});
			this.sessionStore.insertMessages(sms);
		}
	}

	private async _summarizeAsync(results: SessionSearchResult[], query: string): Promise<void> {
		if (!this.sessionStore) return;
		const sessions = results.map((r) => ({
			messages: this.sessionStore!.getMessages(r.sessionId),
			query,
			meta: { startedAt: r.startedAt, source: r.source, model: r.model },
		}));
		try {
			const summaries = await this.summarizer!.summarizeAll(sessions);
			for (let i = 0; i < results.length && i < summaries.length; i++) {
				if (summaries[i]) results[i].summary = summaries[i];
			}
		} catch {
			/* graceful */
		}
	}
}
