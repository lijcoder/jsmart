import type { Api, Model } from "@jsmart/jsmart-ai";

export type MemoryType = "user" | "project" | "feedback" | "reference";

/** A single persisted memory entry. */
export interface Memory {
	/** Unique slug identifier, kebab-case, e.g. "user-lang-pref". */
	name: string;
	/** One-line summary shown in the index to help the agent decide relevance. */
	description: string;
	type: MemoryType;
	/** Markdown body content. */
	content: string;
	created: string; // ISO 8601
	updated: string; // ISO 8601
}

/** Entry in MEMORY.md index. */
export interface MemoryIndexEntry {
	name: string;
	description: string;
	/** Filename, e.g. "user-lang-pref.md" */
	file: string;
}

/** Operations returned by the LLM extractor. */
export type MemoryOperation =
	| { op: "create"; name: string; description: string; type: MemoryType; content: string }
	| { op: "update"; name: string; description?: string; content: string }
	| { op: "delete"; name: string; reason: string }
	| { op: "skip" };

/**
 * A single search result from hybridSearch() — a chunk of a memory file
 * with BM25 relevance score and a line-level citation.
 */
export interface MemorySearchResult {
	/** Memory slug, e.g. "user-lang-pref" */
	name: string;
	/** One-line description from the index */
	description: string;
	/** 1-indexed line in the .md file where this chunk starts */
	startLine: number;
	/** 1-indexed line in the .md file where this chunk ends */
	endLine: number;
	/** BM25-derived relevance score, 0–1 range */
	score: number;
	/** Text of this chunk (may be the full content for small memories) */
	snippet: string;
	/** Citation string, e.g. "user-lang-pref.md#L9-L15" */
	citation: string;
}

/** Options for MemoryManager constructor. */
export interface MemoryManagerOptions {
	/** Directory to store memory files, e.g. "<project>/.jsmart/memory/". */
	memoryDir: string;
	/**
	 * Model used for background extraction. If omitted, automatic extraction is disabled.
	 * Tip: use a small/fast model (e.g. haiku) to reduce cost.
	 */
	extractionModel: Model<Api>;
	/**
	 * API key for the extraction model's provider.
	 * If omitted, the provider's default key resolution is used.
	 */
	extractionApiKey: string;
}
