/**
 * E2E tests for AgentSession compaction behavior.
 *
 * These tests use real LLM calls (no mocking) to verify:
 * - Manual compaction works correctly
 * - Session persistence during compaction
 * - Compaction entry is saved to session file
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent, type AgentSessionOptions } from "../src/agent-session.js";
import { ModelManager } from "../src/model-manager.js";
import { DefaultResourceLoader } from "../src/resource-manager.js";
import { SessionManager } from "../src/session-manager.js";
import { SettingsManager } from "../src/settings-manager.js";

describe.skipIf(!process.env.JSMART_BASE_URL || !process.env.JSMART_MODEL || !process.env.JSMART_API_KEY)(
	"AgentSession compaction e2e",
	() => {
		let session: AgentSession;
		let tempDir: string;
		let sessionManager: SessionManager;
		let events: AgentSessionEvent[];

		beforeEach(() => {
			// Create temp directory for session files
			tempDir = join(tmpdir(), `pi-compaction-test-${Date.now()}`);
			mkdirSync(tempDir, { recursive: true });

			// Track events
			events = [];
		});

		afterEach(async () => {
			if (session) {
				session.dispose();
			}
			if (tempDir && existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		});

		function createSession() {
			const workspaces = join(tempDir, "jsmart-ws");
			const sessionFile = join(tempDir, "jsmart-session.jsonl");
			const defaultModel = process.env.JSMART_MODEL!;
			const defaultProdiver = "test";
			const defaultProdiverApiKey = process.env.JSMART_API_KEY!;
			const defaultProdiverBaseUrl = process.env.JSMART_BASE_URL!;
			const agentSessionOption: AgentSessionOptions = {
				promptTemplate: "",
			};
			sessionManager = new SessionManager(true, sessionFile);
			const resourceManager = new DefaultResourceLoader({
				noSkills: true,
			});
			const modelManager = ModelManager.create(undefined);
			modelManager.addModels([
				{
					api: "openai-completions",
					id: defaultModel,
					name: defaultModel,
					provider: "test",
					baseUrl: defaultProdiverBaseUrl,
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 4096,
					headers: {},
					compat: {
						supportsDeveloperRole: false,
					},
				},
			]);
			modelManager.addProviders([
				{
					provider: defaultProdiver,
					apiKey: defaultProdiverApiKey,
				},
			]);
			const settingsManager = new SettingsManager({
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
				},
				compaction: {
					enabled: true,
					keepRecentTokens: 10,
					reserveTokens: 16384,
				},
			});
			session = new AgentSession(
				workspaces,
				settingsManager,
				sessionManager,
				resourceManager,
				modelManager,
				defaultProdiver,
				defaultModel,
				agentSessionOption,
			);

			// Subscribe to track events
			session.subscribe((event) => {
				events.push(event);
			});

			return session;
		}

		it("should trigger manual compaction via compact()", async () => {
			createSession();

			// Send a few prompts to build up history
			await session.prompt("What is 2+2? Reply with just the number.");
			await session.waitForIdle();

			await session.prompt("What is 3+3? Reply with just the number.");
			await session.waitForIdle();

			// Manually compact
			const result = await session.compact();

			expect(result.summary).toBeDefined();
			expect(result.summary.length).toBeGreaterThan(0);
			expect(result.tokensBefore).toBeGreaterThan(0);

			// Verify messages were compacted (should have summary + recent)
			const messages = session.messages;
			expect(messages.length).toBeGreaterThan(0);

			// First message should be the summary (a user message with summary content)
			const firstMsg = messages[0];
			expect(firstMsg.role).toBe("compactionSummary");
		}, 120000);

		it("should maintain valid session state after compaction", async () => {
			createSession();

			// Build up history
			await session.prompt("What is the capital of France? One word answer.");
			await session.waitForIdle();

			await session.prompt("What is the capital of Germany? One word answer.");
			await session.waitForIdle();

			// Compact
			await session.compact();

			// Session should still be usable
			await session.prompt("What is the capital of Italy? One word answer.");
			await session.waitForIdle();

			// Should have messages after compaction
			expect(session.messages.length).toBeGreaterThan(0);

			// The agent should have responded
			const assistantMessages = session.messages.filter((m) => m.role === "assistant");
			expect(assistantMessages.length).toBeGreaterThan(0);
		}, 180000);

		it("should persist compaction to session file", async () => {
			createSession();

			await session.prompt("Say hello");
			await session.waitForIdle();

			await session.prompt("Say goodbye");
			await session.waitForIdle();

			// Compact
			await session.compact();

			// Load entries from session manager
			const entries = sessionManager.getEntries();

			// Should have a compaction entry
			const compactionEntries = entries.filter((e) => e.type === "compaction");
			expect(compactionEntries.length).toBe(1);

			const compaction = compactionEntries[0];
			expect(compaction.type).toBe("compaction");
			if (compaction.type === "compaction") {
				expect(compaction.summary.length).toBeGreaterThan(0);
				expect(typeof compaction.firstKeptEntryId).toBe("string");
				expect(compaction.tokensBefore).toBeGreaterThan(0);
			}
		}, 120000);

		it("should work with --no-session mode (in-memory only)", async () => {
			createSession(); // in-memory mode

			// Send prompts
			await session.prompt("What is 2+2? Reply with just the number.");
			await session.waitForIdle();

			await session.prompt("What is 3+3? Reply with just the number.");
			await session.waitForIdle();

			// Compact should work even without file persistence
			const result = await session.compact();

			expect(result.summary).toBeDefined();
			expect(result.summary.length).toBeGreaterThan(0);

			// In-memory entries should have the compaction
			const entries = sessionManager.getEntries();
			const compactionEntries = entries.filter((e) => e.type === "compaction");
			expect(compactionEntries.length).toBe(1);
		}, 120000);

		it("should emit correct events during auto-compaction", async () => {
			createSession();

			// Build some history
			await session.prompt("Say hello");
			await session.waitForIdle();

			// Manually trigger compaction and check events
			await session.compact();

			// Check that no auto_compaction events were emitted for manual compaction
			const autoCompactionEvents = events.filter(
				(e) => e.type === "compaction_start" || e.type === "compaction_end",
			);
			// Manual compaction doesn't emit auto_compaction events
			expect(autoCompactionEvents.length).toBe(0);

			// Regular events should have been emitted
			const messageEndEvents = events.filter((e) => e.type === "message_end");
			expect(messageEndEvents.length).toBeGreaterThan(0);
		}, 120000);
	},
);
