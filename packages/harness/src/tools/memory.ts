import type { AgentTool } from "@jsmart/jsmart-agent-core";
import type { MemoryManager } from "@jsmart/jsmart-memory";
import { Type } from "@sinclair/typebox";

const searchSchema = Type.Object({
	query: Type.String({
		description: "Search keyword to match against memory name, description, and content",
	}),
});

/**
 * Creates the read-only `memory_search` agent tool backed by a MemoryManager.
 *
 * Uses hybridSearch() for BM25-ranked results with line-level citations
 * (e.g. `user-lang-pref.md#L9-L15`).  Writes, updates, and deletes are
 * handled automatically by the MemoryManager background hooks — the agent is
 * intentionally kept read-only.
 */
export function createMemorySearchTool(manager: MemoryManager): AgentTool<typeof searchSchema> {
	return {
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search the persistent memory store for relevant facts: user preferences, project constraints, coding conventions, or past decisions. Use this to recall context from previous sessions before starting a task.",
		parameters: searchSchema,
		execute: async (_toolCallId, { query }) => {
			const results = manager.hybridSearch(query, { maxResults: 6 });
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No memories found matching: "${query}"` }],
					details: [],
				};
			}
			const text = results
				.map((r) => `### ${r.name}  ·  \`${r.citation}\`\n_${r.description}_\n\n${r.snippet}`)
				.join("\n\n---\n\n");
			return {
				content: [{ type: "text", text }],
				details: results,
			};
		},
	};
}
