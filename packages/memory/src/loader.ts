import type { MemoryStore } from "./store.js";

/** Formats the memory index for injection into an agent system prompt. */
export class MemoryLoader {
	constructor(private store: MemoryStore) {}

	/**
	 * Returns a markdown block describing the memory index, suitable for appending
	 * to an agent's system prompt. Returns null when there are no memories yet.
	 */
	formatForPrompt(): string | null {
		const index = this.store.listIndex();
		if (index.length === 0) return null;

		return [
			"## 记忆库",
			"",
			"你有以下持久记忆，使用 memory_search 工具查询详细内容：",
			"",
			...index.map((e) => `- **${e.name}**: ${e.description}`),
			"",
		].join("\n");
	}
}
