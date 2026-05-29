import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, Type } from "@jsmart/jsmart-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionOptions } from "../src/agent-session.js";
import { ModelManager } from "../src/model-manager.js";
import { SessionManager } from "../src/session-manager.js";
import { SettingsManager } from "../src/settings-manager.js";

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

describe("AgentSession retry", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `jsmart-retry-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			// session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession(
		initAgentSessionOption?: AgentSessionOptions,
		options?: { failCount?: number; maxRetries?: number; delayAssistantMessageEndMs?: number },
	) {
		const failCount = options?.failCount ?? 1;
		const maxRetries = options?.maxRetries ?? 3;
		const workspaces = join(tempDir, "jsmart-ws");
		const sessionFile = join(tempDir, "jsmart-session.jsonl");
		const defaultModel = "test-model";
		const defaultProdiver = "test";
		let callCount = 0;
		const agentSessionOption: AgentSessionOptions = initAgentSessionOption ?? {
			promptTemplate: "",
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount <= failCount) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		};
		const sessionManager = new SessionManager(false, sessionFile);
		const modelManager = ModelManager.create(undefined);
		modelManager.addModels([
			{
				id: defaultModel,
				name: defaultModel,
				api: "openai-completions",
				provider: defaultProdiver,
				baseUrl: "http://test.com/api",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
				headers: {},
			},
		]);
		modelManager.addProviders([
			{
				provider: defaultProdiver,
				apiKey: "test",
			},
		]);
		const settingsManager = new SettingsManager({
			defaultModel: { provider: defaultProdiver, model: defaultModel },
			retry: {
				enabled: true,
				maxRetries: maxRetries,
				baseDelayMs: 1,
			},
		});
		session = new AgentSession(workspaces, settingsManager, sessionManager, modelManager, agentSessionOption);
		return { session, getCallCount: () => callCount };
	}

	it("retries after a transient error and succeeds", async () => {
		const created = createSession(undefined, { failCount: 1 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
		expect(created.session.isRetrying).toBe(false);
	});

	it("exhausts max retries and emits failure", async () => {
		const created = createSession(undefined, { failCount: 99, maxRetries: 2 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(3);
		expect(events).toContain("start:1");
		expect(events).toContain("start:2");
		expect(events).toContain("end:success=false");
		expect(created.session.isRetrying).toBe(false);
	});

	it("retries provider network_error failures", async () => {
		let callCount = 0;
		const agentSessionOption: AgentSessionOptions = {
			promptTemplate: "",
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "Provider finish_reason: network_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
						return;
					}

					const msg = createAssistantMessage("Recovered after retry");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		};
		const created = createSession(agentSessionOption, { failCount: 1 });
		created.getCallCount = () => callCount;
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
		expect(created.session.isRetrying).toBe(false);
	});

	it("prompt waits for full agent loop when retry produces tool calls", async () => {
		// Regression: when auto-retry fires and the retry response includes tool_use,
		// session.prompt() must wait for the entire tool loop to finish before returning.
		// Previously, _resolveRetry() on the first successful message_end would unblock
		// waitForRetry() while the agent was still executing tools.
		const toolExecuted = { value: false };

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted.value = true;
				return { content: [{ type: "text", text: "echoed" }], details: undefined };
			},
		};
		let callCount = 0;
		const agentSessionOption: AgentSessionOptions = {
			promptTemplate: "",
			tools: [echoTool],
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						// First call: overloaded error
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else if (callCount === 2) {
						// Second call (retry): text + tool_use
						const msg: AssistantMessage = {
							...createAssistantMessage("Looking that up now."),
							stopReason: "toolUse",
							content: [
								{ type: "text", text: "Looking that up now." },
								{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hello" } },
							],
						};
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					} else {
						// Third call (after tool result): final response
						const msg = createAssistantMessage("Final answer.");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		};
		const created = createSession(agentSessionOption, { failCount: 1 });
		created.getCallCount = () => callCount;

		await created.session.prompt("Test");

		// All three LLM calls must have completed
		expect(callCount).toBe(3);
		// Tool must have been executed
		expect(toolExecuted.value).toBe(true);
		// Agent must not be streaming after prompt returns
		expect(created.session.isProcessing()).toBe(false);
		// A follow-up prompt must work (no "Agent is already processing" error)
		await created.session.prompt("Follow-up");
		expect(callCount).toBe(4);
	});
});
