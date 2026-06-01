/**
 * Real LLM integration tests for MemoryExtractor.
 *
 * Requires a running model endpoint. Configure via test/.env:
 *   { "JSMART_BASE_URL": "...", "JSMART_MODEL": "...", "JSMART_API_KEY": "..." }
 *
 * Run: pnpm test (skipped automatically when env vars are absent)
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@jsmart/jsmart-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryExtractor } from "../src/extractor.js";
import { MemoryStore } from "../src/store.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
	const dir = join(tmpdir(), `jsmart-memory-llm-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ── Real LLM Suite ───────────────────────────────────────────────────────────

describe.skipIf(!process.env.JSMART_BASE_URL || !process.env.JSMART_MODEL || !process.env.JSMART_API_KEY)(
	"MemoryExtractor (real LLM)",
	() => {
		let model: Model<"openai-completions">;
		let tempDir: string;
		let store: MemoryStore;
		let extractor: MemoryExtractor;

		beforeAll(() => {
			model = {
				id: process.env.JSMART_MODEL!,
				name: process.env.JSMART_MODEL!,
				api: "openai-completions",
				provider: "test",
				baseUrl: process.env.JSMART_BASE_URL!,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4_096,
				headers: { Authorization: `Bearer ${process.env.JSMART_API_KEY!}` },
				compat: { supportsDeveloperRole: false },
			};
		});

		beforeEach(() => {
			tempDir = makeTempDir();
			store = new MemoryStore(tempDir);
			extractor = new MemoryExtractor(store, model, process.env.JSMART_API_KEY);
		});

		afterEach(() => {
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		});

		it("extracts a user preference from a short conversation", async () => {
			await extractor.extract([
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "I always prefer TypeScript over JavaScript, and I want all code comments written in Chinese.",
						},
					],
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Understood! I'll use TypeScript and write comments in Chinese from now on." },
					],
					api: "openai-completions" as any,
					provider: "test" as any,
					model: process.env.JSMART_MODEL!,
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
				},
			]);

			const memories = store.readAll();
			console.log(
				"Extracted memories:",
				memories.map((m) => `${m.name}: ${m.description}`),
			);

			// At least one memory should have been created
			expect(memories.length).toBeGreaterThanOrEqual(1);

			// The extracted content should reference TypeScript or Chinese
			const allContent = memories.map((m) => m.content.toLowerCase()).join(" ");
			const allDesc = memories.map((m) => m.description.toLowerCase()).join(" ");
			const combined = allContent + " " + allDesc;
			expect(combined.includes("typescript") || combined.includes("chinese") || combined.includes("中文")).toBe(
				true,
			);
		});

		it("skips extraction for pure small talk (no memorable facts)", async () => {
			await extractor.extract([
				{
					role: "user",
					content: [{ type: "text", text: "Hi there! How's it going?" }],
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "All good, thanks for asking! What can I help you with today?" }],
					api: "openai-completions" as any,
					provider: "test" as any,
					model: process.env.JSMART_MODEL!,
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
				},
			]);

			const memories = store.readAll();
			console.log("Memories after small talk:", memories.length);
			// May be 0 (ideal) or small — the model should not hallucinate memorable facts
			expect(memories.length).toBeLessThanOrEqual(1);
		});

		it("updates an existing memory when new info contradicts it", async () => {
			// Seed an existing memory
			store.write({
				name: "project-lang",
				description: "Project uses JavaScript",
				type: "project",
				content: "The project is written in plain JavaScript.",
				created: new Date().toISOString(),
				updated: new Date().toISOString(),
			});

			// Conversation contradicts the existing memory
			await extractor.extract([
				{
					role: "user",
					content: [{ type: "text", text: "We finished migrating the entire project to TypeScript last week." }],
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Great, I'll note that the project is now in TypeScript." }],
					api: "openai-completions" as any,
					provider: "test" as any,
					model: process.env.JSMART_MODEL!,
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
				},
			]);

			const memories = store.readAll();
			console.log(
				"Memories after contradiction:",
				memories.map((m) => `${m.name}: ${m.content.slice(0, 60)}`),
			);

			// The combined content across all memories should mention TypeScript
			const allContent = memories.map((m) => m.content.toLowerCase()).join(" ");
			expect(allContent).toContain("typescript");
		});
	},
);
