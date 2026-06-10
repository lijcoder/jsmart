import type { Api, Model } from "@jsmart/jsmart-ai";

/** Target memory store: agent's own notes or user profile. */
export type MemoryTarget = "memory" | "user";

/** A single memory entry in MEMORY.md or USER.md. */
export interface MemoryEntry {
	/** The plain-text content of this entry. */
	content: string;
}

/** Result returned by memory tool operations. */
export interface MemoryResult {
	success: boolean;
	target: MemoryTarget;
	message?: string;
	usage: string; // e.g. "34% — 748/2,200 chars"
	entryCount: number;
	entries: string[];
}

// ── Session search types (unchanged from P0-P2) ───────────────────────────

export interface SessionMessage {
	id: number;
	sessionId: string;
	role: "user" | "assistant" | "toolResult";
	content: string;
	toolName?: string;
	timestamp: number;
}

export interface SessionMeta {
	id: string;
	source: string;
	model: string;
	startedAt: number;
	lastActive: number;
	messageCount: number;
	preview: string;
}

export interface SessionSearchResult {
	sessionId: string;
	title: string;
	source: string;
	startedAt: string;
	model: string;
	snippet: string;
	score: number;
	summary?: string;
}

export interface SessionSearchOptions {
	query?: string;
	/** ISO 8601 start date, e.g. '2025-06-01'. If set, only sessions active on or after this date. */
	from?: string;
	/** ISO 8601 end date. If set, only sessions active on or before this date. */
	to?: string;
	maxResults?: number;
	roleFilter?: string;
}

// ── MemoryManager options ─────────────────────────────────────────────────

export interface MemoryManagerOptions {
	/** Base directory, e.g. "<project>/.jsmart/memory/". User data stored in {userId}/ subfolder. */
	memoryDir: string;
	/** Required: scopes memories and sessions to a specific user. */
	userId: string;
	/** Optional: scopes to a project for multi-project filtering. */
	projectId?: string;
	/** Character limit for MEMORY.md (default: 2200). */
	memoryCharLimit?: number;
	/** Character limit for USER.md (default: 1375). */
	userCharLimit?: number;

	// session_search summarization (required — use a cheap/fast model like haiku)
	summarizationModel: Model<Api>;
	summarizationApiKey?: string;
}
