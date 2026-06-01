import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, UserMessage } from "@jsmart/jsmart-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryExtractor } from "../src/extractor.js";
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
	const dir = join(tmpdir(), `jsmart-memory-extractor-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function userMsg(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMsg(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
	};
}

function mockLlmResponse(ops: object[]): void {
	mockComplete.mockResolvedValueOnce({
		role: "assistant",
		content: [{ type: "text", text: JSON.stringify(ops) }],
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

describe("MemoryExtractor", () => {
	let tempDir: string;
	let store: MemoryStore;
	let extractor: MemoryExtractor;
	const fakeModel = {} as any;

	beforeEach(() => {
		tempDir = makeTempDir();
		store = new MemoryStore(tempDir);
		extractor = new MemoryExtractor(store, fakeModel);
		mockComplete.mockReset();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		vi.restoreAllMocks();
	});

	it("does not call the LLM when the conversation has no text", async () => {
		const toolResult: Message = {
			role: "toolResult",
			toolCallId: "1",
			toolName: "bash",
			content: [{ type: "text", text: "output" }],
			isError: false,
			timestamp: Date.now(),
		};
		await extractor.extract([toolResult]);
		expect(mockComplete).not.toHaveBeenCalled();
	});

	it("does not call the LLM for an empty message list", async () => {
		await extractor.extract([]);
		expect(mockComplete).not.toHaveBeenCalled();
	});

	it("calls completeSimple with a prompt containing the conversation text", async () => {
		mockLlmResponse([{ op: "skip" }]);
		await extractor.extract([userMsg("I prefer TypeScript"), assistantMsg("Got it!")]);

		expect(mockComplete).toHaveBeenCalledOnce();
		const [, context] = mockComplete.mock.calls[0];
		const promptText = (context.messages[0].content as any)[0].text as string;
		expect(promptText).toContain("I prefer TypeScript");
		expect(promptText).toContain("Got it!");
	});

	it("creates a new memory from a create operation", async () => {
		mockLlmResponse([
			{
				op: "create",
				name: "user-lang-pref",
				description: "User prefers TypeScript",
				type: "user",
				content: "User explicitly chose TypeScript over JavaScript.",
			},
		]);

		await extractor.extract([userMsg("I prefer TypeScript")]);

		const mem = store.read("user-lang-pref");
		expect(mem).not.toBeNull();
		expect(mem!.content).toBe("User explicitly chose TypeScript over JavaScript.");
	});

	it("updates an existing memory from an update operation", async () => {
		store.write({
			name: "project-stack",
			description: "Tech stack",
			type: "project",
			content: "JavaScript",
			created: "2026-01-01T00:00:00.000Z",
			updated: "2026-01-01T00:00:00.000Z",
		});

		mockLlmResponse([{ op: "update", name: "project-stack", content: "TypeScript ESM" }]);
		await extractor.extract([userMsg("We migrated to TypeScript")]);

		expect(store.read("project-stack")!.content).toBe("TypeScript ESM");
	});

	it("deletes a memory from a delete operation", async () => {
		store.write({
			name: "old-fact",
			description: "Old",
			type: "reference",
			content: "Body",
			created: "2026-01-01T00:00:00.000Z",
			updated: "2026-01-01T00:00:00.000Z",
		});

		mockLlmResponse([{ op: "delete", name: "old-fact", reason: "No longer relevant" }]);
		await extractor.extract([userMsg("Forget about that")]);

		expect(store.read("old-fact")).toBeNull();
	});

	it("handles a skip operation without touching the store", async () => {
		mockLlmResponse([{ op: "skip" }]);
		await extractor.extract([userMsg("Just chatting")]);
		expect(store.readAll()).toHaveLength(0);
	});

	it("throws when the LLM returns an error stop reason", async () => {
		mockComplete.mockResolvedValueOnce({
			role: "assistant",
			content: [],
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
			stopReason: "error",
			errorMessage: "Rate limit exceeded",
			timestamp: Date.now(),
		});

		await expect(extractor.extract([userMsg("hello")])).rejects.toThrow("Rate limit exceeded");
	});

	it("handles a malformed JSON response gracefully (no operations applied)", async () => {
		mockComplete.mockResolvedValueOnce({
			role: "assistant",
			content: [{ type: "text", text: "Sorry, I cannot help with that." }],
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

		// Should not throw — silently applies zero operations
		await extractor.extract([userMsg("something")]);
		expect(store.readAll()).toHaveLength(0);
	});

	it("includes existing memories in the LLM prompt", async () => {
		store.write({
			name: "existing",
			description: "Existing memory",
			type: "feedback",
			content: "Already known fact",
			created: "2026-01-01T00:00:00.000Z",
			updated: "2026-01-01T00:00:00.000Z",
		});

		mockLlmResponse([{ op: "skip" }]);
		await extractor.extract([userMsg("New info")]);

		const [, context] = mockComplete.mock.calls[0];
		const promptText = (context.messages[0].content as any)[0].text as string;
		expect(promptText).toContain("existing");
		expect(promptText).toContain("Already known fact");
	});

	it("filters out tool calls from the conversation — only user/assistant text is sent", async () => {
		mockLlmResponse([{ op: "skip" }]);

		const toolResult: Message = {
			role: "toolResult",
			toolCallId: "42",
			toolName: "bash",
			content: [{ type: "text", text: "secret tool output" }],
			isError: false,
			timestamp: Date.now(),
		};

		await extractor.extract([userMsg("Run the test"), toolResult, assistantMsg("Done!")]);

		const [, context] = mockComplete.mock.calls[0];
		const promptText = (context.messages[0].content as any)[0].text as string;
		expect(promptText).not.toContain("secret tool output");
		expect(promptText).toContain("Run the test");
		expect(promptText).toContain("Done!");
	});
});
