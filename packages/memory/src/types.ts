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

/** Options for MemoryManager constructor. */
export interface MemoryManagerOptions {
	/** Directory to store memory files, e.g. "<project>/.jsmart/memory/". */
	memoryDir: string;
	/**
	 * Model used for background extraction. If omitted, automatic extraction is disabled.
	 * Tip: use a small/fast model (e.g. haiku) to reduce cost.
	 */
	extractionModel?: Model<Api>;
	/**
	 * Number of turns between automatic extraction runs.
	 * @default 5
	 */
	extractionInterval?: number;
}

/** Persisted extraction state, saved to .state.json inside memoryDir. */
export interface MemoryState {
	/** Index into the all-messages array at the time of the last successful extraction. */
	lastExtractedMessageIndex: number;
	lastExtractedAt: string; // ISO 8601, empty string if never extracted
}
