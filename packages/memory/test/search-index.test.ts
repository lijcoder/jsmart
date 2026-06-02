import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bm25ToScore, buildFtsQuery, chunkMemory, MemorySearchIndex, preprocessForFts } from "../src/search-index.js";
import type { Memory } from "../src/types.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		name: "test-memory",
		description: "A test memory entry",
		type: "project",
		content: "Some content here.\n\n**Why:** Testing.\n**How to apply:** Use in tests.",
		created: "2026-06-01T00:00:00.000Z",
		updated: "2026-06-01T00:00:00.000Z",
		...overrides,
	};
}

function makeTempDbPath(): string {
	return join(tmpdir(), `jsmart-search-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// ── chunkMemory ──────────────────────────────────────────────────────────────

describe("chunkMemory", () => {
	it("returns empty array for empty content", () => {
		expect(chunkMemory(makeMemory({ content: "" }))).toEqual([]);
		expect(chunkMemory(makeMemory({ content: "   " }))).toEqual([]);
	});

	it("small content produces a single chunk starting at line 9", () => {
		const mem = makeMemory({ content: "Short content." });
		const chunks = chunkMemory(mem);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].startLine).toBe(9);
		expect(chunks[0].endLine).toBe(9); // one line
	});

	it("single chunk text is description + blank line + content", () => {
		const mem = makeMemory({ content: "Short content." });
		const chunks = chunkMemory(mem);
		expect(chunks[0].text).toBe("A test memory entry\n\nShort content.");
	});

	it("single chunk id encodes name and line range", () => {
		const mem = makeMemory({ content: "Short content." });
		const [chunk] = chunkMemory(mem);
		expect(chunk.id).toBe("test-memory:9:9");
	});

	it("multi-line single-chunk content: endLine = 9 + (lines - 1)", () => {
		const content = "Line one.\nLine two.\nLine three.";
		const mem = makeMemory({ content });
		const chunks = chunkMemory(mem);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].startLine).toBe(9);
		expect(chunks[0].endLine).toBe(11); // 3 lines
	});

	it("content exceeding CHUNK_MAX_CHARS is split at paragraph boundaries", () => {
		// Create content with two clearly separated long paragraphs
		const para1 = "A".repeat(400);
		const para2 = "B".repeat(400);
		const content = `${para1}\n\n${para2}`;
		const mem = makeMemory({ content });
		const chunks = chunkMemory(mem);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
	});

	it("each large-content chunk includes description as context prefix", () => {
		const para1 = "A".repeat(400);
		const para2 = "B".repeat(400);
		const mem = makeMemory({ content: `${para1}\n\n${para2}` });
		const chunks = chunkMemory(mem);
		for (const chunk of chunks) {
			expect(chunk.text).toContain(mem.description);
		}
	});

	it("multi-chunk line numbers are monotonically increasing", () => {
		const para1 = "A".repeat(400);
		const para2 = "B".repeat(400);
		const mem = makeMemory({ content: `${para1}\n\n${para2}` });
		const chunks = chunkMemory(mem);
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i].startLine).toBeGreaterThan(chunks[i - 1].endLine);
		}
	});

	it("first chunk startLine is always 9 regardless of content size", () => {
		for (const size of [10, 100, 700, 2000]) {
			const mem = makeMemory({ content: "X".repeat(size) });
			const chunks = chunkMemory(mem);
			expect(chunks[0].startLine).toBe(9);
		}
	});
});

// ── buildFtsQuery ────────────────────────────────────────────────────────────

describe("buildFtsQuery", () => {
	it("returns null for empty string", () => {
		expect(buildFtsQuery("")).toBeNull();
		expect(buildFtsQuery("   ")).toBeNull();
	});

	it("returns null for punctuation-only string", () => {
		expect(buildFtsQuery("!@#$%")).toBeNull();
	});

	it("converts single word to a quoted OR term", () => {
		expect(buildFtsQuery("hello")).toBe('"hello"');
	});

	it("converts multiple words to quoted OR terms", () => {
		expect(buildFtsQuery("user language preference")).toBe('"user" OR "language" OR "preference"');
	});

	it("segments CJK text into word tokens via Jieba", () => {
		// Jieba splits "用户偏好" → ["用户", "偏好"], each becomes a quoted OR term
		const q = buildFtsQuery("用户偏好");
		expect(q).not.toBeNull();
		expect(q).toContain('"用户"');
		expect(q).toContain('"偏好"');
	});

	it("single CJK word remains as one token", () => {
		const q = buildFtsQuery("偏好");
		expect(q).toBe('"偏好"');
	});

	it("strips double-quote characters from tokens to avoid FTS5 injection", () => {
		const q = buildFtsQuery('say "hello"');
		expect(q).not.toContain('""');
	});
});

// ── preprocessForFts ─────────────────────────────────────────────────────────

describe("preprocessForFts", () => {
	it("segments Chinese text into space-separated words", () => {
		const out = preprocessForFts("用户偏好设置");
		// Jieba: ["用户","偏好","设置"] → "用户 偏好 设置"
		expect(out).toContain("用户");
		expect(out).toContain("偏好");
		expect(out).toContain("设置");
	});

	it("leaves English tokens intact", () => {
		expect(preprocessForFts("TypeScript project")).toContain("TypeScript");
	});

	it("handles mixed Chinese and English", () => {
		const out = preprocessForFts("用户 prefers TypeScript");
		expect(out).toContain("用户");
		expect(out).toContain("TypeScript");
	});

	it("strips whitespace-only tokens", () => {
		const out = preprocessForFts("  偏好  ");
		expect(out.startsWith(" ")).toBe(false);
		expect(out.endsWith(" ")).toBe(false);
	});
});

// ── bm25ToScore ──────────────────────────────────────────────────────────────

describe("bm25ToScore", () => {
	it("returns 0 for non-finite rank", () => {
		expect(bm25ToScore(Number.NaN)).toBe(0);
		expect(bm25ToScore(Number.POSITIVE_INFINITY)).toBe(0);
	});

	it("more negative rank → higher score", () => {
		const scoreA = bm25ToScore(-10);
		const scoreB = bm25ToScore(-1);
		expect(scoreA).toBeGreaterThan(scoreB);
	});

	it("score is in [0, 1] range", () => {
		for (const rank of [-100, -10, -1, -0.001, 0, 0.1]) {
			const s = bm25ToScore(rank);
			expect(s).toBeGreaterThanOrEqual(0);
			expect(s).toBeLessThanOrEqual(1);
		}
	});

	it("rank 0 → score 0", () => {
		expect(bm25ToScore(0)).toBe(0);
	});
});

// ── MemorySearchIndex ────────────────────────────────────────────────────────

describe("MemorySearchIndex", () => {
	let dbPath: string;
	let index: MemorySearchIndex;

	beforeEach(() => {
		dbPath = makeTempDbPath();
		index = new MemorySearchIndex(dbPath);
	});

	afterEach(() => {
		index.close();
		if (existsSync(dbPath)) rmSync(dbPath);
	});

	// ── Basic search ──────────────────────────────────────────────────────────

	it("returns empty array when index is empty", () => {
		expect(index.search("anything")).toEqual([]);
	});

	it("returns empty array for empty query", () => {
		index.reindex([makeMemory()]);
		expect(index.search("")).toEqual([]);
		expect(index.search("   ")).toEqual([]);
	});

	it("finds a memory by keyword in content", () => {
		const mem = makeMemory({ content: "The user prefers dark mode." });
		index.reindex([mem]);
		const results = index.search("dark mode");
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("test-memory");
	});

	it("finds a memory by keyword in description", () => {
		const mem = makeMemory({ description: "User dark-mode preference" });
		index.reindex([mem]);
		const results = index.search("dark-mode");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].name).toBe("test-memory");
	});

	it("returns empty array when no memory matches", () => {
		index.reindex([makeMemory({ content: "Cats are fluffy." })]);
		expect(index.search("quantum physics")).toEqual([]);
	});

	// ── Citations ─────────────────────────────────────────────────────────────

	it("result includes citation in name.md#Lstart-Lend format", () => {
		index.reindex([makeMemory()]);
		const [result] = index.search("content");
		expect(result.citation).toMatch(/^test-memory\.md#L\d+-L\d+$/);
	});

	it("citation startLine is 9 (content after 8-line frontmatter)", () => {
		index.reindex([makeMemory({ content: "Single line content." })]);
		const [result] = index.search("single");
		expect(result.startLine).toBe(9);
		expect(result.citation).toContain("L9");
	});

	// ── Relevance ranking ─────────────────────────────────────────────────────

	it("result has a score in (0, 1]", () => {
		index.reindex([makeMemory()]);
		const [result] = index.search("content");
		expect(result.score).toBeGreaterThan(0);
		expect(result.score).toBeLessThanOrEqual(1);
	});

	it("more relevant memory ranks first", () => {
		const high = makeMemory({
			name: "high-relevance",
			content: "TypeScript TypeScript TypeScript is the primary language.",
		});
		const low = makeMemory({
			name: "low-relevance",
			content: "We occasionally use TypeScript for scripts.",
		});
		index.reindex([low, high]);
		const results = index.search("TypeScript");
		expect(results[0].name).toBe("high-relevance");
	});

	// ── reindex / stale data ──────────────────────────────────────────────────

	it("reindex with updated memories reflects new content", () => {
		const old = makeMemory({ content: "Old content with keyword banana." });
		index.reindex([old]);
		expect(index.search("banana")).toHaveLength(1);

		// Update memory — remove "banana"
		const updated = makeMemory({ content: "New content without that word." });
		index.reindex([updated]);

		expect(index.search("banana")).toHaveLength(0);
	});

	it("reindex with fewer memories removes stale entries", () => {
		// Use single-token identifiers that don't appear in the other memory
		const a = makeMemory({ name: "mem-a", description: "desc-a", content: "bananaXYZ is delicious." });
		const b = makeMemory({ name: "mem-b", description: "desc-b", content: "watermelonABC is refreshing." });
		index.reindex([a, b]);
		expect(index.search("bananaXYZ")).toHaveLength(1);
		expect(index.search("watermelonABC")).toHaveLength(1);

		// Remove mem-b
		index.reindex([a]);
		expect(index.search("bananaXYZ")).toHaveLength(1);
		expect(index.search("watermelonABC")).toHaveLength(0);
	});

	it("can call reindex multiple times without errors", () => {
		const mem = makeMemory();
		expect(() => index.reindex([mem])).not.toThrow();
		expect(() => index.reindex([mem])).not.toThrow();
		expect(() => index.reindex([])).not.toThrow();
	});

	// ── maxResults ────────────────────────────────────────────────────────────

	it("respects maxResults option", () => {
		const memories = Array.from({ length: 10 }, (_, i) =>
			makeMemory({ name: `mem-${i}`, content: `Shared keyword repeated content item ${i}.` }),
		);
		index.reindex(memories);
		const results = index.search("keyword repeated", { maxResults: 3 });
		expect(results.length).toBeLessThanOrEqual(3);
	});

	// ── Chinese (CJK) search ─────────────────────────────────────────────────

	it("finds a memory by 2-character Chinese word", () => {
		const mem = makeMemory({ content: "用户的语言偏好是中文。" });
		index.reindex([mem]);
		const results = index.search("偏好");
		expect(results).toHaveLength(1);
		expect(results[0].snippet).toContain("偏好");
	});

	it("finds a memory by Chinese keyword in description", () => {
		const mem = makeMemory({ description: "用户中文偏好", content: "User prefers Chinese." });
		index.reindex([mem]);
		expect(index.search("中文")).toHaveLength(1);
	});

	it("Chinese search returns correct citation format", () => {
		const mem = makeMemory({ content: "用户偏好中文回复。" });
		index.reindex([mem]);
		const [result] = index.search("偏好");
		expect(result.citation).toMatch(/^test-memory\.md#L\d+-L\d+$/);
	});

	// ── Snippet content ───────────────────────────────────────────────────────

	it("snippet contains the matched text", () => {
		const mem = makeMemory({ content: "The secret passphrase is openSesame." });
		index.reindex([mem]);
		const [result] = index.search("openSesame");
		expect(result.snippet).toContain("openSesame");
	});

	// ── Persistence ───────────────────────────────────────────────────────────

	it("index persists across close/reopen", () => {
		index.reindex([makeMemory({ content: "Persistent keyword xyzzy." })]);
		index.close();

		// Reopen same DB file
		index = new MemorySearchIndex(dbPath);
		const results = index.search("xyzzy");
		expect(results).toHaveLength(1);
	});
});
