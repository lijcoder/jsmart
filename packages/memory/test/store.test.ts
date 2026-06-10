import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory-store.js";

function tmpDir() {
	const dir = join(tmpdir(), `jsmart-mem-test-${randomUUID()}`);
	return dir;
}

describe("MemoryStore (Hermes-style)", () => {
	describe("loadFromDisk", () => {
		it("creates empty entries when no files exist", () => {
			const dir = tmpDir();
			try {
				const store = new MemoryStore(dir);
				store.loadFromDisk();
				expect(store.memoryEntries).toEqual([]);
				expect(store.userEntries).toEqual([]);
			} finally {
				try {
					rmSync(dir, { recursive: true });
				} catch {
					/* ignore */
				}
			}
		});

		it("loads entries from existing files and deduplicates", () => {
			const dir = tmpDir();
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "MEMORY.md"), "fact one\n§\nfact two\n§\nfact one", "utf-8");
				writeFileSync(join(dir, "USER.md"), "user fact", "utf-8");

				const store = new MemoryStore(dir);
				store.loadFromDisk();
				expect(store.memoryEntries).toEqual(["fact one", "fact two"]);
				expect(store.userEntries).toEqual(["user fact"]);
			} finally {
				try {
					rmSync(dir, { recursive: true });
				} catch {
					/* ignore */
				}
			}
		});

		it("captures a frozen snapshot", () => {
			const dir = tmpDir();
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "MEMORY.md"), "test entry", "utf-8");

				const store = new MemoryStore(dir);
				store.loadFromDisk();

				const prompt = store.formatForSystemPrompt("memory");
				expect(prompt).toContain("test entry");
				expect(prompt).toContain("MEMORY");

				// Snapshot stays stable even after mutation
				store.add("memory", "new entry");
				const prompt2 = store.formatForSystemPrompt("memory");
				expect(prompt2).toBe(prompt); // unchanged!
			} finally {
				try {
					rmSync(dir, { recursive: true });
				} catch {
					/* ignore */
				}
			}
		});
	});

	describe("add", () => {
		it("adds a new entry", () => {
			const dir = tmpDir();
			try {
				const store = new MemoryStore(dir);
				store.loadFromDisk();
				const r = store.add("memory", "project uses pnpm");
				expect(r.success).toBe(true);
				expect(r.entries).toContain("project uses pnpm");
				expect(r.entryCount).toBe(1);
			} finally {
				try {
					rmSync(dir, { recursive: true });
				} catch {
					/* ignore */
				}
			}
		});

		it("rejects empty content", () => {
			const store = new MemoryStore(tmpDir());
			const r = store.add("memory", "  ");
			expect(r.success).toBe(false);
		});

		it("rejects exact duplicates", () => {
			const dir = tmpDir();
			try {
				const store = new MemoryStore(dir);
				store.loadFromDisk();
				store.add("memory", "fact");
				const r = store.add("memory", "fact");
				expect(r.success).toBe(true); // not an error, just skipped
				expect(r.message).toContain("already exists");
			} finally {
				try {
					rmSync(dir, { recursive: true });
				} catch {
					/* ignore */
				}
			}
		});

		it("supports user target", () => {
			const dir = tmpDir();
			try {
				const store = new MemoryStore(dir);
				store.loadFromDisk();
				const r = store.add("user", "prefers TypeScript");
				expect(r.success).toBe(true);
				expect(r.target).toBe("user");
			} finally {
				try {
					rmSync(dir, { recursive: true });
				} catch {
					/* ignore */
				}
			}
		});
	});

	describe("replace", () => {
		it("replaces by substring match", () => {
			const dir = tmpDir();
			try {
				const store = new MemoryStore(dir);
				store.loadFromDisk();
				store.add("memory", "OS is Ubuntu 22.04");
				const r = store.replace("memory", "Ubuntu", "OS is macOS 15");
				expect(r.success).toBe(true);
				expect(r.entries).toContain("OS is macOS 15");
				expect(r.entries).not.toContain("OS is Ubuntu 22.04");
			} finally {
				try {
					rmSync(dir, { recursive: true });
				} catch {
					/* ignore */
				}
			}
		});

		it("fails when no match", () => {
			const store = new MemoryStore(tmpDir());
			store.loadFromDisk();
			store.add("memory", "some fact");
			const r = store.replace("memory", "nonexistent", "new");
			expect(r.success).toBe(false);
		});
	});

	describe("remove", () => {
		it("removes by substring match", () => {
			const dir = tmpDir();
			try {
				const store = new MemoryStore(dir);
				store.loadFromDisk();
				store.add("memory", "delete me");
				store.add("memory", "keep me");
				const r = store.remove("memory", "delete");
				expect(r.success).toBe(true);
				expect(r.entryCount).toBe(1);
				expect(r.entries).toEqual(["keep me"]);
			} finally {
				try {
					rmSync(dir, { recursive: true });
				} catch {
					/* ignore */
				}
			}
		});
	});

	describe("persistence", () => {
		it("writes to disk and survives reload", () => {
			const dir = tmpDir();
			try {
				const store1 = new MemoryStore(dir);
				store1.loadFromDisk();
				store1.add("memory", "persisted fact");
				store1.add("user", "user fact");

				const store2 = new MemoryStore(dir);
				store2.loadFromDisk();
				expect(store2.memoryEntries).toEqual(["persisted fact"]);
				expect(store2.userEntries).toEqual(["user fact"]);
			} finally {
				try {
					rmSync(dir, { recursive: true });
				} catch {
					/* ignore */
				}
			}
		});
	});
});
