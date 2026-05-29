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
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Usage } from "@jsmart/jsmart-ai";
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

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-model",
		provider: "test",
		model: "mock",
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
		...overrides,
	};
}

describe("AgentSession auto compact", () => {
	let session: AgentSession;
	let tempDir: string;
	let defaultModel: string;
	let defaultProdiver: string;
	let defaultProdiverApiKey: string;
	let defaultProdiverBaseUrl: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `jsmart-retry-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		defaultModel = process.env.JSMART_MODEL!;
		defaultProdiver = "test";
		defaultProdiverApiKey = process.env.JSMART_API_KEY!;
		defaultProdiverBaseUrl = process.env.JSMART_BASE_URL!;
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession(
		initAgentSessionOption: AgentSessionOptions,
		settingsManager: SettingsManager,
		contextWindow?: number,
	) {
		const workspaces = join(tempDir, "jsmart-ws");
		const sessionFile = join(tempDir, "jsmart-session.jsonl");
		const agentSessionOption = initAgentSessionOption;
		const sessionManager = new SessionManager(true, sessionFile);
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
				contextWindow: contextWindow ?? 100_000,
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
		return { session, getCallCount: () => 0 };
	}

	it("should trigger auto compaction via overflow error", async () => {
		let callCount = 0;
		const agentSessionOption: AgentSessionOptions = {
			promptTemplate: "",
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 5) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: `Provider finish_reason(${callCount}): too many tokens`,
							model: defaultModel,
							provider: defaultProdiver,
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const s = Array(41).join(`${callCount}`);
						const msg = createAssistantMessage(s, { model: defaultModel, provider: defaultProdiver });
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
						return;
					}
				});
				return stream;
			},
		};
		const created = createSession(
			agentSessionOption,
			new SettingsManager({
				compaction: {
					enabled: true,
					reserveTokens: 1000,
					keepRecentTokens: 20,
				},
			}),
		);
		created.getCallCount = () => callCount;
		const compactEvents: AgentSessionEvent[] = [];
		const events: AgentSessionEvent[] = [];
		created.session.subscribe((event) => {
			events.push(event);
			if (event.type === "compaction_start") compactEvents.push(event);
			if (event.type === "compaction_end") compactEvents.push(event);
		});

		for (let i: number = 1; i <= 5; i++) {
			await created.session.prompt(`test-${i}`);
		}

		// prompt共执行5次，contunue执行1，compact执行1次，continue没有userMessage事件为6，一次有userMessage的完整事件有8个
		expect(created.getCallCount()).toBe(6);
		expect(compactEvents.length).toBe(2);
		expect(events.length).toBe(48);
	}, 120000);

	it("should trigger auto compaction via shoud compact", async () => {
		let callCount = 0;
		const agentSessionOption: AgentSessionOptions = {
			promptTemplate: "",
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount <= 5) {
						const s = Array(41).join(`${callCount}`);
						const totalTokens: number = callCount === 5 ? 55 : 0;
						const usage: Usage = {
							totalTokens: totalTokens,
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						};
						const msg = createAssistantMessage(s, { model: defaultModel, provider: defaultProdiver, usage });
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
						return;
					}
				});
				return stream;
			},
		};
		const created = createSession(
			agentSessionOption,
			new SettingsManager({
				compaction: {
					enabled: true,
					reserveTokens: 60,
					keepRecentTokens: 20,
				},
			}),
			100,
		);
		created.getCallCount = () => callCount;
		const compactEvents: AgentSessionEvent[] = [];
		const events: AgentSessionEvent[] = [];
		created.session.subscribe((event) => {
			events.push(event);
			if (event.type === "compaction_start") compactEvents.push(event);
			if (event.type === "compaction_end") compactEvents.push(event);
		});

		for (let i: number = 1; i <= 5; i++) {
			await created.session.prompt(`test-${i}`);
		}

		// prompt共执行5次，contunue执行1，compact执行1次，continue没有userMessage事件为6，一次有userMessage的完整事件有8个
		console.log(`contextToken: ${created.session.getContextTokens()}`);
		expect(created.getCallCount()).toBe(5);
		expect(compactEvents.length).toBe(2);
		expect(events.length).toBe(42);
	}, 120000);
});
