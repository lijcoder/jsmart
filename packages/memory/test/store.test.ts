import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store.js";
import type { Memory } from "../src/types.js";

function makeTempDir(): string {
	const dir = join(tmpdir(), `jsmart-memory-store-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

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

describe("MemoryStore", () => {
	let tempDir: string;
	let store: MemoryStore;

	beforeEach(() => {
		tempDir = makeTempDir();
		store = new MemoryStore(tempDir);
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	// ── write / read ────────────────────────────────────────────────────────────

	describe("write and read", () => {
		it("round-trips a memory through the file system", () => {
			const mem = makeMemory();
			store.write(mem);

			const result = store.read("test-memory");
			expect(result).not.toBeNull();
			expect(result!.name).toBe("test-memory");
			expect(result!.description).toBe("A test memory entry");
			expect(result!.type).toBe("project");
			expect(result!.content).toBe(mem.content);
			expect(result!.created).toBe("2026-06-01T00:00:00.000Z");
			expect(result!.updated).toBe("2026-06-01T00:00:00.000Z");
		});

		it("creates the file with correct frontmatter format", () => {
			store.write(makeMemory());
			const raw = readFileSync(join(tempDir, "test-memory.md"), "utf-8");
			expect(raw).toContain("---");
			expect(raw).toContain("name: test-memory");
			expect(raw).toContain("description: A test memory entry");
			expect(raw).toContain("type: project");
		});

		it("overwrites an existing memory with the same name", () => {
			store.write(makeMemory({ description: "original" }));
			store.write(makeMemory({ description: "updated" }));
			expect(store.read("test-memory")!.description).toBe("updated");
		});

		it("returns null for a non-existent memory", () => {
			expect(store.read("no-such-memory")).toBeNull();
		});

		it("auto-creates the directory via ensureDir", () => {
			const nested = join(tempDir, "deep", "nested");
			const nestedStore = new MemoryStore(nested);
			nestedStore.ensureDir();
			expect(existsSync(nested)).toBe(true);
		});
	});

	// ── readAll ─────────────────────────────────────────────────────────────────

	describe("readAll", () => {
		it("returns an empty array when the directory is empty", () => {
			expect(store.readAll()).toEqual([]);
		});

		it("returns all written memories", () => {
			store.write(makeMemory({ name: "mem-a" }));
			store.write(makeMemory({ name: "mem-b" }));
			const all = store.readAll();
			expect(all).toHaveLength(2);
			const names = all.map((m) => m.name).sort();
			expect(names).toEqual(["mem-a", "mem-b"]);
		});

		it("excludes MEMORY.md from the result", () => {
			store.write(makeMemory({ name: "real-memory" }));
			const all = store.readAll();
			expect(all.every((m) => m.name !== "MEMORY")).toBe(true);
		});
	});

	// ── MEMORY.md index ─────────────────────────────────────────────────────────

	describe("index (MEMORY.md)", () => {
		it("creates MEMORY.md when writing the first memory", () => {
			store.write(makeMemory());
			expect(existsSync(join(tempDir, "MEMORY.md"))).toBe(true);
		});

		it("listIndex parses index entries correctly", () => {
			store.write(makeMemory({ name: "user-pref", description: "User preferences" }));
			store.write(makeMemory({ name: "project-arch", description: "Architecture docs" }));

			const index = store.listIndex();
			expect(index).toHaveLength(2);

			const pref = index.find((e) => e.name === "user-pref");
			expect(pref).toBeDefined();
			expect(pref!.description).toBe("User preferences");
			expect(pref!.file).toBe("user-pref.md");
		});

		it("updates an existing index line on re-write", () => {
			store.write(makeMemory({ description: "old description" }));
			store.write(makeMemory({ description: "new description" }));

			const index = store.listIndex();
			expect(index).toHaveLength(1);
			expect(index[0].description).toBe("new description");
		});

		it("listIndex returns empty array when MEMORY.md does not exist", () => {
			expect(store.listIndex()).toEqual([]);
		});
	});

	// ── delete ──────────────────────────────────────────────────────────────────

	describe("delete", () => {
		it("removes the markdown file", () => {
			store.write(makeMemory());
			store.delete("test-memory");
			expect(existsSync(join(tempDir, "test-memory.md"))).toBe(false);
		});

		it("removes the entry from MEMORY.md", () => {
			store.write(makeMemory());
			store.delete("test-memory");
			expect(store.listIndex()).toHaveLength(0);
		});

		it("returns false for a non-existent memory", () => {
			expect(store.delete("ghost")).toBe(false);
		});

		it("leaves other entries in the index intact", () => {
			store.write(makeMemory({ name: "keep-me" }));
			store.write(makeMemory({ name: "delete-me" }));
			store.delete("delete-me");
			const index = store.listIndex();
			expect(index).toHaveLength(1);
			expect(index[0].name).toBe("keep-me");
		});
	});

	// ── applyOperations ─────────────────────────────────────────────────────────

	describe("applyOperations", () => {
		const NOW = "2026-06-01T12:00:00.000Z";

		it("creates a new memory for op=create", () => {
			store.applyOperations(
				[{ op: "create", name: "new-mem", description: "Desc", type: "user", content: "Body" }],
				NOW,
			);
			const mem = store.read("new-mem");
			expect(mem).not.toBeNull();
			expect(mem!.content).toBe("Body");
			expect(mem!.created).toBe(NOW);
		});

		it("updates an existing memory for op=update", () => {
			store.write(makeMemory({ name: "existing", content: "old content" }));
			store.applyOperations([{ op: "update", name: "existing", content: "new content" }], NOW);
			expect(store.read("existing")!.content).toBe("new content");
			expect(store.read("existing")!.updated).toBe(NOW);
		});

		it("op=update preserves description when not provided", () => {
			store.write(makeMemory({ name: "existing", description: "original desc" }));
			store.applyOperations([{ op: "update", name: "existing", content: "new" }], NOW);
			expect(store.read("existing")!.description).toBe("original desc");
		});

		it("op=update is a no-op when the memory does not exist", () => {
			// Should not throw
			store.applyOperations([{ op: "update", name: "ghost", content: "x" }], NOW);
			expect(store.read("ghost")).toBeNull();
		});

		it("deletes a memory for op=delete", () => {
			store.write(makeMemory({ name: "old-fact" }));
			store.applyOperations([{ op: "delete", name: "old-fact", reason: "Outdated" }], NOW);
			expect(store.read("old-fact")).toBeNull();
		});

		it("skips for op=skip", () => {
			store.write(makeMemory({ name: "untouched" }));
			store.applyOperations([{ op: "skip" }], NOW);
			expect(store.read("untouched")).not.toBeNull();
		});

		it("handles a mixed batch of operations", () => {
			store.write(makeMemory({ name: "keep", content: "old" }));
			store.write(makeMemory({ name: "remove" }));

			store.applyOperations(
				[
					{ op: "create", name: "fresh", description: "New", type: "reference", content: "Data" },
					{ op: "update", name: "keep", content: "updated" },
					{ op: "delete", name: "remove", reason: "Gone" },
					{ op: "skip" },
				],
				NOW,
			);

			expect(store.read("fresh")).not.toBeNull();
			expect(store.read("keep")!.content).toBe("updated");
			expect(store.read("remove")).toBeNull();
		});
	});
});
