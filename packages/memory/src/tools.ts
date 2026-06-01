import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { Type } from "@sinclair/typebox";
import type { MemoryManager } from "./manager.js";

const searchSchema = Type.Object({
	query: Type.String({
		description: "Search keyword to match against memory name, description, and content",
	}),
});

/**
 * Returns the read-only agent tools for querying the memory store.
 * Only memory_search is exposed — writes happen automatically in the background.
 */
export function createMemoryTools(manager: MemoryManager): AgentTool<typeof searchSchema>[] {
	return [
		{
			name: "memory_search",
			label: "Memory Search",
			description:
				"Search the persistent memory store for relevant facts: user preferences, project constraints, coding conventions, or past decisions. Use this to recall context from previous sessions before starting a task.",
			parameters: searchSchema,
			execute: async (_toolCallId, { query }) => {
				const results = manager.search(query);
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: `No memories found matching: "${query}"` }],
						details: [],
					};
				}
				const text = results.map((m) => `### ${m.name}\n_${m.description}_\n\n${m.content}`).join("\n\n---\n\n");
				return {
					content: [{ type: "text", text }],
					details: results,
				};
			},
		},
	];
}
