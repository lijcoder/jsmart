import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/session-store.js";
import type { SessionMessage } from "../src/types.js";

function tmpDb() {
	const path = join(tmpdir(), `jsmart-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	return { path, store: new SessionStore(path) };
}

function makeMsg(overrides: Partial<SessionMessage> & { sessionId: string }): SessionMessage {
	return {
		id: 0,
		role: "user",
		content: "hello",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("SessionStore", () => {
	describe("insert + upsert", () => {
		it("inserts a message and assigns an id", () => {
			const { store, path } = tmpDb();
			try {
				store.upsertSession({ id: "s1", startedAt: 1000, lastActive: 2000, messageCount: 0 });
				const msg = makeMsg({ sessionId: "s1", content: "hello world" });
				store.insertMessage(msg);
				expect(msg.id).toBeGreaterThan(0);
			} finally {
				store.close();
				try {
					unlinkSync(path);
				} catch {}
			}
		});

		it("inserts multiple messages", () => {
			const { store, path } = tmpDb();
			try {
				store.upsertSession({ id: "s1", startedAt: 1000, lastActive: 2000, messageCount: 0 });
				const msgs = [
					makeMsg({ sessionId: "s1", role: "user", content: "user query" }),
					makeMsg({ sessionId: "s1", role: "assistant", content: "assistant response" }),
				];
				store.insertMessages(msgs);
				expect(msgs[0].id).toBeGreaterThan(0);
				expect(msgs[1].id).toBeGreaterThan(0);
			} finally {
				store.close();
				try {
					unlinkSync(path);
				} catch {}
			}
		});

		it("upserts session metadata with userId and projectId", () => {
			const { store, path } = tmpDb();
			try {
				store.upsertSession({
					id: "s1",
					source: "cli",
					model: "test-model",
					userId: "user-1",
					projectId: "project-x",
					startedAt: 1000,
					lastActive: 2000,
					messageCount: 2,
				});
				const sessions = store.listSessions();
				expect(sessions).toHaveLength(1);
				expect(sessions[0].id).toBe("s1");
				expect(sessions[0].messageCount).toBe(2);
			} finally {
				store.close();
				try {
					unlinkSync(path);
				} catch {}
			}
		});
	});

	describe("listSessions", () => {
		it("returns empty array when no sessions", () => {
			const { store, path } = tmpDb();
			try {
				expect(store.listSessions()).toEqual([]);
			} finally {
				store.close();
				try {
					unlinkSync(path);
				} catch {}
			}
		});

		it("returns sessions ordered by last_active desc", () => {
			const { store, path } = tmpDb();
			try {
				store.upsertSession({ id: "older", startedAt: 1000, lastActive: 1000, messageCount: 1 });
				store.upsertSession({ id: "newer", startedAt: 2000, lastActive: 3000, messageCount: 1 });
				const sessions = store.listSessions();
				expect(sessions).toHaveLength(2);
				expect(sessions[0].id).toBe("newer");
				expect(sessions[1].id).toBe("older");
			} finally {
				store.close();
				try {
					unlinkSync(path);
				} catch {}
			}
		});
	});

	describe("search", () => {
		it("returns empty for no query and no sessions", () => {
			const { store, path } = tmpDb();
			try {
				expect(store.search({})).toEqual([]);
			} finally {
				store.close();
				try {
					unlinkSync(path);
				} catch {}
			}
		});

		it("returns recent sessions when query is empty", () => {
			const { store, path } = tmpDb();
			try {
				store.upsertSession({ id: "s1", startedAt: 1000, lastActive: 2000, messageCount: 1 });
				const results = store.search({});
				expect(results).toHaveLength(1);
				expect(results[0].sessionId).toBe("s1");
			} finally {
				store.close();
				try {
					unlinkSync(path);
				} catch {}
			}
		});

		it("searches by keyword and finds matching messages", () => {
			const { store, path } = tmpDb();
			try {
				store.upsertSession({ id: "s1", startedAt: 1000, lastActive: 2000, messageCount: 1 });
				store.insertMessage(makeMsg({ sessionId: "s1", role: "user", content: "docker deployment failed" }));
				const results = store.search({ query: "docker deployment" });
				expect(results.length).toBeGreaterThan(0);
				expect(results[0].snippet).toContain("docker");
			} finally {
				store.close();
				try {
					unlinkSync(path);
				} catch {}
			}
		});

		it("searches Chinese text with Jieba tokenisation", () => {
			const { store, path } = tmpDb();
			try {
				store.upsertSession({ id: "s1", startedAt: 1000, lastActive: 2000, messageCount: 1 });
				store.upsertSession({ id: "s2", startedAt: 1000, lastActive: 2000, messageCount: 1 });
				store.insertMessage(
					makeMsg({ sessionId: "s1", role: "user", content: "Docker 部署的时候出现了端口绑定错误" }),
				);
				store.insertMessage(makeMsg({ sessionId: "s2", role: "user", content: "今天天气不错" }));

				// Searching for "部署" should find the first session
				const results = store.search({ query: "部署" });
				expect(results.length).toBeGreaterThan(0);
				expect(results[0].snippet).toContain("Docker");
			} finally {
				store.close();
				try {
					unlinkSync(path);
				} catch {}
			}
		});

		it("filters by days range", () => {
			const { store, path } = tmpDb();
			try {
				const now = Date.now() / 1000;
				const weekAgo = now - 8 * 86_400;

				store.upsertSession({ id: "old", startedAt: weekAgo, lastActive: weekAgo, messageCount: 1 });
				store.insertMessage(makeMsg({ sessionId: "old", content: "old docker issue", timestamp: weekAgo * 1000 }));

				store.upsertSession({ id: "recent", startedAt: now, lastActive: now, messageCount: 1 });
				store.insertMessage(makeMsg({ sessionId: "recent", content: "recent docker fix", timestamp: now * 1000 }));

				const results = store.search({
					query: "docker",
					from: new Date(now * 1000 - 7 * 86_400_000).toISOString(),
				});
				expect(results).toHaveLength(1);
				expect(results[0].sessionId).toBe("recent");
			} finally {
				store.close();
				try {
					unlinkSync(path);
				} catch {}
			}
		});

		it("deduplicates sessions in search results", () => {
			const { store, path } = tmpDb();
			try {
				store.upsertSession({ id: "s1", startedAt: 1000, lastActive: 2000, messageCount: 2 });
				store.insertMessage(makeMsg({ sessionId: "s1", content: "docker error" }));
				store.insertMessage(makeMsg({ sessionId: "s1", content: "docker fix applied" }));
				const results = store.search({ query: "docker" });
				expect(results).toHaveLength(1);
			} finally {
				store.close();
				try {
					unlinkSync(path);
				} catch {}
			}
		});
	});
});
