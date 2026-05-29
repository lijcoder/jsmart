import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session-manager.js";

function createSessionManager(): SessionManager {
	const sessionPath = join(__dirname, "fixtures/session-compact.jsonl");
	const sessionManger = new SessionManager(true, sessionPath);
	return sessionManger;
}

describe("SessionManager", () => {
	it("build agent messages", () => {
		const sessionManager = createSessionManager();
		const sessionContext = sessionManager.buildSessionContext();

		expect(sessionContext.messages.length).toBe(8);
		expect(sessionContext.messages[0].role).toBe("compactionSummary");
		expect(sessionContext.messages[7].role).toBe("assistant");
	});
});
