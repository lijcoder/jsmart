import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryLoader } from "../src/loader.js";
import { MemoryStore } from "../src/store.js";
import type { Memory } from "../src/types.js";

function makeTempDir(): string {
	const dir = join(tmpdir(), `jsmart-memory-loader-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeMemory(store: MemoryStore, overrides: Partial<Memory> = {}): void {
	store.write({
		name: "default-mem",
		description: "Default description",
		type: "project",
		content: "Content body",
		created: "2026-06-01T00:00:00.000Z",
		updated: "2026-06-01T00:00:00.000Z",
		...overrides,
	});
}

describe("MemoryLoader", () => {
	let tempDir: string;
	let store: MemoryStore;
	let loader: MemoryLoader;

	beforeEach(() => {
		tempDir = makeTempDir();
		store = new MemoryStore(tempDir);
		loader = new MemoryLoader(store);
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("returns null when there are no memories", () => {
		expect(loader.formatForPrompt()).toBeNull();
	});

	it("returns a non-null string when memories exist", () => {
		writeMemory(store);
		expect(loader.formatForPrompt()).not.toBeNull();
	});

	it("includes all memory names in the output", () => {
		writeMemory(store, { name: "user-lang-pref", description: "User prefers Chinese" });
		writeMemory(store, { name: "project-stack", description: "TypeScript monorepo" });

		const output = loader.formatForPrompt()!;
		expect(output).toContain("user-lang-pref");
		expect(output).toContain("project-stack");
	});

	it("includes descriptions in the output", () => {
		writeMemory(store, { name: "my-mem", description: "My custom description" });
		const output = loader.formatForPrompt()!;
		expect(output).toContain("My custom description");
	});

	it("contains a memory_search reference to guide the agent", () => {
		writeMemory(store);
		const output = loader.formatForPrompt()!;
		expect(output).toContain("memory_search");
	});
});
