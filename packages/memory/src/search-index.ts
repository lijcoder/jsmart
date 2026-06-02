import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { Memory, MemorySearchResult } from "./types.js";

// ── Jieba loader ──────────────────────────────────────────────────────────────
// @node-rs/jieba is a CJS package with no ESM exports field; load via require.

const _require = createRequire(import.meta.url);

interface JiebaInstance {
	cut(sentence: string, hmm: boolean): string[];
	cutForSearch(sentence: string, hmm: boolean): string[];
}

const { Jieba } = _require("@node-rs/jieba") as {
	Jieba: { withDict(dict: Uint8Array): JiebaInstance };
};
const { dict } = _require("@node-rs/jieba/dict") as { dict: Uint8Array };

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Number of lines consumed by YAML frontmatter + trailing blank line:
 *   ---          line 1
 *   name: ...    line 2
 *   description: line 3
 *   type: ...    line 4
 *   created: ... line 5
 *   updated: ... line 6
 *   ---          line 7
 *                line 8  (blank)
 * Content starts at line 9.
 */
const FRONTMATTER_LINE_COUNT = 8;

/** Max chars for a single chunk before splitting by paragraph. */
const CHUNK_MAX_CHARS = 600;

// ── Jieba singleton ───────────────────────────────────────────────────────────

/**
 * Module-level singleton loaded with the bundled default dictionary.
 * Initialisation takes ~50 ms and should happen only once per process.
 */
const jieba = Jieba.withDict(dict);

// ── Internal types ─────────────────────────────────────────────────────────────

interface Chunk {
	id: string;
	startLine: number;
	endLine: number;
	/** Original text stored in `chunks` table and returned as the snippet. */
	text: string;
	/** Jieba-segmented version inserted into FTS5. */
	ftsText: string;
}

interface RawRow {
	name: string;
	description: string;
	start_line: number;
	end_line: number;
	text: string;
	rank: number;
}

interface ChunkRow {
	fts_rowid: number | bigint;
}

interface ConfigRow {
	value: string;
}

// ── Text helpers ───────────────────────────────────────────────────────────────

/**
 * Segments `text` using Jieba `cutForSearch` with HMM enabled, then joins
 * the resulting tokens with spaces.  FTS5's default `unicode61` tokeniser
 * subsequently splits on those spaces, giving each Jieba token its own entry
 * in the inverted index.
 *
 * Example:
 *   "用户偏好设置 TypeScript"
 *   → jieba: ["用户","偏好","设置","TypeScript"]
 *   → output: "用户 偏好 设置 TypeScript"
 */
export function preprocessForFts(text: string): string {
	return jieba
		.cutForSearch(text, /* hmm */ true)
		.filter((t) => t.trim().length > 0)
		.join(" ");
}

/**
 * Builds a FTS5 MATCH query string from a natural-language query.
 *
 * Uses Jieba `cutForSearch` to segment the query (same tokenisation as
 * indexing), then wraps each token in double-quotes and joins with OR.
 * OR gives maximum recall; BM25 ranking surfaces the most relevant results.
 *
 * Examples:
 *   "偏好"        → `"偏好"`
 *   "语言偏好"    → `"语言" OR "偏好"`
 *   "dark mode"   → `"dark" OR "mode"`
 *
 * Returns null when no usable tokens are found (empty / whitespace-only input).
 */
export function buildFtsQuery(raw: string): string | null {
	const tokens = jieba
		.cutForSearch(raw.trim(), /* hmm */ true)
		.map((t) => t.trim())
		// Keep only tokens that contain at least one letter or digit
		.filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t));

	if (tokens.length === 0) return null;

	const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
	return quoted.join(" OR ");
}

/**
 * Converts a raw FTS5 BM25 rank (negative, more-negative = more relevant) to
 * a [0, 1] relevance score using the formula: score = R / (1 + R) where R = -rank.
 */
export function bm25ToScore(rank: number): number {
	if (!Number.isFinite(rank)) return 0;
	const relevance = Math.max(0, -rank);
	return relevance / (1 + relevance);
}

// ── Chunking ───────────────────────────────────────────────────────────────────

/**
 * Splits a memory's content into searchable chunks that track their
 * line numbers within the .md file.
 *
 * For small memories (content ≤ CHUNK_MAX_CHARS) the whole content is one
 * chunk.  For larger ones we split on blank lines (paragraph boundaries) and
 * prepend the description to each chunk so every result carries enough context.
 */
export function chunkMemory(mem: Memory): Chunk[] {
	const content = mem.content.trim();
	if (!content) return [];

	const contentStartLine = FRONTMATTER_LINE_COUNT + 1; // line 9

	const makeChunk = (text: string, startLine: number, endLine: number): Chunk => ({
		id: `${mem.name}:${startLine}:${endLine}`,
		startLine,
		endLine,
		text,
		ftsText: preprocessForFts(text),
	});

	if (content.length <= CHUNK_MAX_CHARS) {
		const text = `${mem.description}\n\n${content}`;
		const endLine = contentStartLine + content.split("\n").length - 1;
		return [makeChunk(text, contentStartLine, endLine)];
	}

	// Multi-chunk: split on paragraph boundaries
	const paragraphs = content.split(/\n{2,}/);
	const chunks: Chunk[] = [];
	let lineOffset = contentStartLine;

	for (const para of paragraphs) {
		const trimmed = para.trim();
		if (!trimmed) continue;

		const paraLineCount = para.split("\n").length;
		const startLine = lineOffset;
		const endLine = lineOffset + paraLineCount - 1;

		chunks.push(makeChunk(`${mem.description}\n\n${trimmed}`, startLine, endLine));
		lineOffset = endLine + 2;
	}

	return chunks;
}

// ── MemorySearchIndex ──────────────────────────────────────────────────────────

/**
 * SQLite-backed full-text search index for memory entries.
 *
 * Architecture:
 * - `chunks`     — plain table holding original text, line numbers, and the
 *                  rowid of the corresponding FTS5 row (needed for deletion).
 * - `chunks_fts` — FTS5 virtual table (unicode61 tokeniser).  Text is
 *                  pre-segmented by Jieba before insertion so that Chinese
 *                  phrases become discrete, searchable tokens.
 *
 * The index is rebuilt in full after every extraction cycle; since there are
 * typically < 100 memory entries this is fast (< 20 ms).
 */
export class MemorySearchIndex {
	private readonly db: DatabaseSync;

	constructor(dbPath: string) {
		this.db = new DatabaseSync(dbPath);
		this._ensureSchema();
	}

	// ── Schema ───────────────────────────────────────────────────────────────

	private _ensureSchema(): void {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id          TEXT    PRIMARY KEY,
        name        TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        start_line  INTEGER NOT NULL,
        end_line    INTEGER NOT NULL,
        text        TEXT    NOT NULL,
        fts_rowid   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_name ON chunks(name);
    `);

		// If a previous version created chunks_fts with the 'trigram' tokeniser,
		// drop it so we can recreate with the default unicode61 tokeniser.
		// Safe because reindex() is always called after construction.
		this._migrateFtsIfNeeded();
	}

	private _migrateFtsIfNeeded(): void {
		let tokenizer = "unicode61";
		try {
			const row = this.db.prepare("SELECT value FROM chunks_fts_config WHERE k = 'tokenize'").get() as unknown as
				| ConfigRow
				| undefined;
			if (row) tokenizer = row.value;
		} catch {
			// Table doesn't exist yet — first run, nothing to migrate
		}

		if (tokenizer !== "unicode61") {
			this.db.exec("DROP TABLE IF EXISTS chunks_fts");
			this.db.exec("DELETE FROM chunks");
		}

		this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        name        UNINDEXED,
        description UNINDEXED,
        start_line  UNINDEXED,
        end_line    UNINDEXED
      );
    `);
	}

	// ── Indexing ─────────────────────────────────────────────────────────────

	/**
	 * Full rebuild: clears the entire index and re-indexes every memory.
	 * Called after each extraction cycle and once at startup (for warm-up).
	 */
	reindex(memories: Memory[]): void {
		const existing = this.db.prepare("SELECT fts_rowid FROM chunks").all() as unknown as ChunkRow[];

		const deleteFts = this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
		for (const row of existing) {
			deleteFts.run(row.fts_rowid);
		}
		this.db.exec("DELETE FROM chunks");

		for (const mem of memories) {
			this._insertChunks(mem);
		}
	}

	// ── Search ───────────────────────────────────────────────────────────────

	/**
	 * FTS5 BM25-ranked search with Jieba query tokenisation.
	 *
	 * @param query          Natural-language query (Chinese and/or English).
	 * @param opts.maxResults  Maximum results to return (default 8).
	 * @returns              Results sorted by relevance (best first).
	 */
	search(query: string, opts?: { maxResults?: number }): MemorySearchResult[] {
		const ftsQuery = buildFtsQuery(query);
		if (!ftsQuery) return [];

		const limit = opts?.maxResults ?? 8;

		const rows = this.db
			.prepare(
				`SELECT c.name, c.description, c.start_line, c.end_line, c.text,
                bm25(chunks_fts) AS rank
         FROM chunks_fts
         JOIN chunks c ON chunks_fts.rowid = c.fts_rowid
         WHERE chunks_fts MATCH ?
         ORDER BY rank ASC
         LIMIT ?`,
			)
			.all(ftsQuery, limit) as unknown as RawRow[];

		return rows.map((row) => ({
			name: row.name,
			description: row.description,
			startLine: row.start_line,
			endLine: row.end_line,
			score: bm25ToScore(row.rank),
			snippet: row.text,
			citation: `${row.name}.md#L${row.start_line}-L${row.end_line}`,
		}));
	}

	/** Closes the underlying database connection. */
	close(): void {
		this.db.close();
	}

	// ── Private helpers ───────────────────────────────────────────────────────

	private _insertChunks(mem: Memory): void {
		const chunks = chunkMemory(mem);
		if (chunks.length === 0) return;

		const insertFts = this.db.prepare(
			`INSERT INTO chunks_fts(text, name, description, start_line, end_line)
       VALUES (?, ?, ?, ?, ?)`,
		);
		const insertChunk = this.db.prepare(
			`INSERT OR REPLACE INTO chunks(id, name, description, start_line, end_line, text, fts_rowid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		);

		for (const chunk of chunks) {
			// Insert Jieba-segmented text into FTS5 for indexing
			const ftsResult = insertFts.run(chunk.ftsText, mem.name, mem.description, chunk.startLine, chunk.endLine);
			const ftsRowid = Number(ftsResult.lastInsertRowid);
			// Store original text in chunks table for human-readable snippets
			insertChunk.run(chunk.id, mem.name, mem.description, chunk.startLine, chunk.endLine, chunk.text, ftsRowid);
		}
	}
}
