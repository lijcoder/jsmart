import type { AgentTool } from "@jsmart/jsmart-agent-core";
import type { MemoryManager } from "@jsmart/jsmart-memory";
import { Type } from "@sinclair/typebox";

const memorySchema = Type.Object({
	action: Type.String({
		description: "The action: 'add' (new entry), 'replace' (update existing), or 'remove' (delete)",
	}),
	target: Type.String({
		description: "Which store: 'memory' (your notes) or 'user' (who the user is)",
	}),
	content: Type.Optional(
		Type.String({
			description: "The entry content. Required for 'add' and 'replace'.",
		}),
	),
	old_text: Type.Optional(
		Type.String({
			description: "Short unique substring identifying the entry to replace or remove.",
		}),
	),
});

/**
 * Creates the `memory` agent tool — Hermes-style persistent curated memory.
 *
 * Two stores:
 * - 'memory': agent's personal notes (environment facts, project conventions, tool quirks)
 * - 'user': what the agent knows about the user (preferences, communication style, pet peeves)
 *
 * Both are injected into the system prompt at session start. Mid-session writes
 * update the files immediately but do NOT change the system prompt in the current
 * session (frozen snapshot pattern — preserves prefix caching).
 */
export function createMemoryTool(manager: MemoryManager): AgentTool<typeof memorySchema> {
	return {
		name: "memory",
		label: "Memory",
		description: `Save durable information to persistent memory that survives across sessions.
Memory is injected into future turns, so keep it compact and focused on facts that will still matter later.

WHEN TO SAVE (do this proactively, don't wait to be asked):
- User corrects you or says "remember this" / "don't do that again"
- User shares a preference, habit, or personal detail (name, role, timezone, coding style)
- You discover something about the environment (OS, installed tools, project structure)
- You learn a convention, API quirk, or workflow specific to this user's setup
- You identify a stable fact that will be useful again in future sessions

PRIORITY: User preferences and corrections > environment facts > procedural knowledge.
The most valuable memory prevents the user from having to repeat themselves.

Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO
state to memory. Use session_search to recall those from past transcripts.

TWO TARGETS:
- 'user': who the user is — name, role, preferences, communication style, pet peeves
- 'memory': your notes — environment facts, project conventions, tool quirks, lessons learned

ACTIONS: add (new entry), replace (update existing — old_text identifies it),
remove (delete — old_text identifies it). Replace/remove use substring matching:
just provide a unique keyword from the entry you want to modify.`,
		parameters: memorySchema,
		execute: async (_toolCallId, params) => {
			const { action, target, content, old_text } = params;
			const t = (target ?? "memory") as "memory" | "user";

			switch (action) {
				case "add": {
					if (!content) {
						return {
							content: [
								{ type: "text", text: JSON.stringify({ success: false, message: "content required for add" }) },
							],
							details: [],
						};
					}
					const r = manager.add(t, content);
					return {
						content: [{ type: "text", text: JSON.stringify(r) }],
						details: [r],
					};
				}
				case "replace": {
					if (!old_text || !content) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										success: false,
										message: "old_text and content required for replace",
									}),
								},
							],
							details: [],
						};
					}
					const r = manager.replace(t, old_text, content);
					return {
						content: [{ type: "text", text: JSON.stringify(r) }],
						details: [r],
					};
				}
				case "remove": {
					if (!old_text) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({ success: false, message: "old_text required for remove" }),
								},
							],
							details: [],
						};
					}
					const r = manager.remove(t, old_text);
					return {
						content: [{ type: "text", text: JSON.stringify(r) }],
						details: [r],
					};
				}
				default:
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									success: false,
									message: `Unknown action: '${action}'. Use: add, replace, remove`,
								}),
							},
						],
						details: [],
					};
			}
		},
	};
}
