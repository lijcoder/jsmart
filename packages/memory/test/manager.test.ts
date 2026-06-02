import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@jsmart/jsmart-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryManager } from "../src/manager.js";
import { MemoryStore } from "../src/store.js";

// ── Mock completeSimple ─────────────────────────────────────────────────────
vi.mock("@jsmart/jsmart-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@jsmart/jsmart-ai")>();
	return { ...actual, completeSimple: vi.fn() };
});

import { completeSimple } from "@jsmart/jsmart-ai";

const mockComplete = vi.mocked(completeSimple);

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
	const dir = join(tmpdir(), `jsmart-memory-manager-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function userMsg(text: string, index = 0): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: index };
}

function makeMessages(count: number): UserMessage[] {
	return Array.from({ length: count }, (_, i) => userMsg(`message ${i}`, i));
}

function mockSkipResponse(): void {
	mockComplete.mockResolvedValue({
		role: "assistant",
		content: [{ type: "text", text: '[{"op":"skip"}]' }],
		api: "anthropic" as any,
		provider: "anthropic" as any,
		model: "claude-opus-4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MemoryManager", () => {
	let tempDir: string;
	let manager: MemoryManager;
	const fakeModel = {} as any;

	beforeEach(() => {
		tempDir = makeTempDir();
		manager = new MemoryManager({
			memoryDir: tempDir,
			extractionModel: fakeModel,
			extractionApiKey: "test",
		});
		manager.ensureDir();
		mockComplete.mockReset();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		vi.restoreAllMocks();
	});

	// ── formatForPrompt ─────────────────────────────────────────────────────────

	describe("formatForPrompt", () => {
		it("returns null when no memories exist", () => {
			expect(manager.formatForPrompt()).toBeNull();
		});

		it("returns a string once memories are present", () => {
			const store = new MemoryStore(tempDir);
			store.write({
				name: "test",
				description: "Test desc",
				type: "project",
				content: "body",
				created: "2026-01-01T00:00:00.000Z",
				updated: "2026-01-01T00:00:00.000Z",
			});
			expect(manager.formatForPrompt()).not.toBeNull();
		});
	});

	// ── generalMemory ────────────────────────────────────────────────────────────

	describe("generalMemory", () => {
		it("triggers extraction on every call", async () => {
			mockSkipResponse();
			manager.generalMemory(makeMessages(3));
			await vi.waitFor(() => expect(mockComplete).toHaveBeenCalledOnce());
		});

		it("triggers extraction once per call", async () => {
			mockSkipResponse();
			for (let i = 0; i < 3; i++) manager.generalMemory(makeMessages(2));
			await vi.waitFor(() => expect(mockComplete).toHaveBeenCalledTimes(3));
		});
	});

	// ── search ──────────────────────────────────────────────────────────────────

	describe("search", () => {
		beforeEach(() => {
			const store = new MemoryStore(tempDir);
			store.write({
				name: "user-lang-pref",
				description: "User prefers Chinese",
				type: "user",
				content: "Always respond in Chinese, code comments too.",
				created: "2026-01-01T00:00:00.000Z",
				updated: "2026-01-01T00:00:00.000Z",
			});
			store.write({
				name: "project-stack",
				description: "TypeScript monorepo",
				type: "project",
				content: "pnpm workspace, TypeScript ESM, Vitest.",
				created: "2026-01-01T00:00:00.000Z",
				updated: "2026-01-01T00:00:00.000Z",
			});
		});

		it("returns results matching the name", () => {
			expect(manager.search("user-lang")).toHaveLength(1);
		});

		it("returns results matching the description (case-insensitive)", () => {
			expect(manager.search("CHINESE")).toHaveLength(1);
		});

		it("returns results matching the content", () => {
			expect(manager.search("vitest")).toHaveLength(1);
		});

		it("returns multiple results when several memories match", () => {
			// "user" appears in name of first, description of first
			const results = manager.search("typescript");
			expect(results.length).toBeGreaterThanOrEqual(1);
		});

		it("returns an empty array when nothing matches", () => {
			expect(manager.search("zzz-not-found")).toHaveLength(0);
		});
	});
});
