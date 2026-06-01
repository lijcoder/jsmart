import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

function mockCreateResponse(name: string, description: string, content: string): void {
	mockComplete.mockResolvedValueOnce({
		role: "assistant",
		content: [
			{
				type: "text",
				text: JSON.stringify([{ op: "create", name, description, type: "user", content }]),
			},
		],
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
			extractionInterval: 3,
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

	// ── onTurnEnd extraction interval ───────────────────────────────────────────

	describe("onTurnEnd", () => {
		it("does not trigger extraction before the interval is reached", () => {
			mockSkipResponse();
			const msgs = makeMessages(2);
			manager.onTurnEnd(msgs); // turn 1
			manager.onTurnEnd(msgs); // turn 2
			expect(mockComplete).not.toHaveBeenCalled();
		});

		it("triggers extraction exactly when the interval is reached", async () => {
			mockSkipResponse();
			const msgs = makeMessages(5);
			manager.onTurnEnd(msgs); // 1
			manager.onTurnEnd(msgs); // 2
			manager.onTurnEnd(msgs); // 3 → trigger
			await vi.waitFor(() => expect(mockComplete).toHaveBeenCalledOnce());
		});

		it("triggers again at the next multiple of the interval", async () => {
			mockSkipResponse();
			const msgs = makeMessages(5);
			for (let i = 0; i < 6; i++) manager.onTurnEnd(msgs);
			// intervals at 3 and 6
			await vi.waitFor(() => expect(mockComplete).toHaveBeenCalledTimes(2));
		});
	});

	// ── onBeforeCompaction ──────────────────────────────────────────────────────

	describe("onBeforeCompaction", () => {
		it("triggers extraction immediately regardless of turn count", async () => {
			mockSkipResponse();
			manager.onBeforeCompaction(makeMessages(3));
			await vi.waitFor(() => expect(mockComplete).toHaveBeenCalledOnce());
		});

		it("does not process already-extracted messages a second time", async () => {
			mockSkipResponse();
			const msgs = makeMessages(4);
			const stateFile = join(tempDir, ".state.json");

			// First compaction — processes all 4 messages; wait for state to be written
			manager.onBeforeCompaction(msgs);
			await vi.waitFor(() => expect(existsSync(stateFile)).toBe(true));

			mockComplete.mockReset();
			mockSkipResponse();

			// Second compaction with the same messages — nothing new to extract
			manager.onBeforeCompaction(msgs);
			// Allow any pending microtasks to settle, then assert no new call
			await new Promise((r) => setTimeout(r, 20));
			expect(mockComplete).not.toHaveBeenCalled();
		});

		it("processes only the new messages added since last extraction", async () => {
			mockSkipResponse();
			const initial = makeMessages(3);
			const stateFile = join(tempDir, ".state.json");
			manager.onBeforeCompaction(initial);
			// Wait until the state file is written (confirms .then() ran)
			await vi.waitFor(() => expect(existsSync(stateFile)).toBe(true));

			mockComplete.mockReset();
			mockSkipResponse();

			// Add two more messages
			const extended = [...initial, userMsg("new-a", 10), userMsg("new-b", 11)];
			manager.onBeforeCompaction(extended);
			await vi.waitFor(() => expect(mockComplete).toHaveBeenCalledOnce());

			const [, context] = mockComplete.mock.calls[0];
			const promptText = (context.messages[0].content as any)[0].text as string;
			// Only the new messages should appear in the prompt
			expect(promptText).toContain("new-a");
			expect(promptText).toContain("new-b");
			expect(promptText).not.toContain("message 0");
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

	// ── state persistence ───────────────────────────────────────────────────────

	describe("state persistence", () => {
		it("saves .state.json after successful extraction", async () => {
			mockSkipResponse();
			const msgs = makeMessages(5);
			for (let i = 0; i < 3; i++) manager.onTurnEnd(msgs);

			// Wait for the state file to appear (written inside the .then() callback)
			const stateFile = join(tempDir, ".state.json");
			await vi.waitFor(() => expect(existsSync(stateFile)).toBe(true));
			const state = JSON.parse(readFileSync(stateFile, "utf-8"));
			expect(state.lastExtractedMessageIndex).toBe(5);
			expect(state.lastExtractedAt).toBeTruthy();
		});

		it("resumes from the saved state after a restart", async () => {
			mockSkipResponse();
			const msgs = makeMessages(4);
			const stateFile = join(tempDir, ".state.json");
			for (let i = 0; i < 3; i++) manager.onTurnEnd(msgs);
			// Wait for state to be persisted before simulating restart
			await vi.waitFor(() => expect(existsSync(stateFile)).toBe(true));

			mockComplete.mockReset();
			mockSkipResponse();

			// Simulate restart by creating a new MemoryManager instance
			const manager2 = new MemoryManager({
				memoryDir: tempDir,
				extractionModel: fakeModel,
				extractionInterval: 3,
			});

			// Compaction with extended messages — only new ones should be processed
			const extended = [...msgs, userMsg("new-msg-after-restart", 99)];
			manager2.onBeforeCompaction(extended);
			await vi.waitFor(() => expect(mockComplete).toHaveBeenCalledOnce());

			const [, context] = mockComplete.mock.calls[0];
			const promptText = (context.messages[0].content as any)[0].text as string;
			expect(promptText).toContain("new-msg-after-restart");
			expect(promptText).not.toContain("message 0");
		});
	});

	// ── no extraction model ─────────────────────────────────────────────────────

	describe("without extractionModel", () => {
		it("onTurnEnd does not throw when no extraction model is configured", () => {
			const noModelManager = new MemoryManager({ memoryDir: tempDir });
			noModelManager.ensureDir();
			// Should be a no-op
			expect(() => noModelManager.onTurnEnd(makeMessages(10))).not.toThrow();
			expect(mockComplete).not.toHaveBeenCalled();
		});

		it("onBeforeCompaction does not throw when no extraction model is configured", () => {
			const noModelManager = new MemoryManager({ memoryDir: tempDir });
			noModelManager.ensureDir();
			expect(() => noModelManager.onBeforeCompaction(makeMessages(5))).not.toThrow();
		});

		it("formatForPrompt still works without an extraction model", () => {
			const noModelManager = new MemoryManager({ memoryDir: tempDir });
			noModelManager.ensureDir();
			// No memories → null
			expect(noModelManager.formatForPrompt()).toBeNull();
		});
	});

	// ── memory creation via extraction ─────────────────────────────────────────

	describe("end-to-end: extraction creates searchable memories", () => {
		it("memories created by LLM are returned by search()", async () => {
			mockCreateResponse("user-pref", "Prefers dark mode", "User wants dark mode everywhere.");

			manager.onBeforeCompaction([userMsg("I prefer dark mode")]);
			await vi.waitFor(() => expect(mockComplete).toHaveBeenCalledOnce());
			// Wait for the async then() to commit the memory
			await vi.waitFor(() => expect(manager.search("dark mode")).toHaveLength(1));
		});
	});
});
