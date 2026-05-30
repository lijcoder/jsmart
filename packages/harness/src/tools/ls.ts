import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { Type } from "@sinclair/typebox";
import type { FsProvider } from "../providers/types.js";
import * as help from "./help.js";
import { type CreateFsToolsOptions, DEFAULT_MAX_OUTPUT_BYTES } from "./help.js";

const editSchema = Type.Object({
	dirPath: Type.String({ description: "Directory path to list (defaults to cwd)" }),
	offset: Type.Optional(Type.Number({ description: "1-based entry number to start listing from" })),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of entries to return (default 100)`, default: 100 }),
	),
});

const DEFAULT_LIMIT = 100;

export function createLsTool(fs: FsProvider, _options?: CreateFsToolsOptions): AgentTool<typeof editSchema> {
	return {
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries (whichever is hit first).`,
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ dirPath, offset, limit }: { dirPath: string; offset?: number; limit?: number },
			_signal?: AbortSignal,
		) => {
			const resolved = fs.resolvePath(dirPath);

			const fsEntries = await fs.readdir(resolved);
			const items: { name: string; type: "file" | "directory" }[] = fsEntries.map((e) => ({
				name: e.name,
				type: e.isDirectory ? ("directory" as const) : ("file" as const),
			}));

			const totalCount = items.length;
			const start = (offset ?? 1) - 1;
			const entryLimit = limit ?? DEFAULT_LIMIT;

			if (start > 0 && start >= totalCount) {
				throw new Error(`Offset ${offset} is out of range (listing has ${totalCount} entries in ${resolved})`);
			}

			const end = Math.min(start + entryLimit, totalCount);
			const page = items.slice(start, end);
			const { items: entries, truncatedByBytes } = help.takeItemsWithinByteLimit(page, DEFAULT_MAX_OUTPUT_BYTES);
			const fromEntry = entries.length > 0 ? start + 1 : 0;
			const toEntry = start + entries.length;
			const hasMore = toEntry < totalCount;

			let status: string;
			if (totalCount === 0) {
				status = "Directory is empty.";
			} else if (truncatedByBytes) {
				status =
					`Output capped at ${help.formatBytes(DEFAULT_MAX_OUTPUT_BYTES)}. ` +
					`Showing entries ${fromEntry}-${toEntry} of ${totalCount}. ` +
					`Use offset=${toEntry + 1} to continue.`;
			} else if (hasMore) {
				status =
					`Showing entries ${fromEntry}-${toEntry} of ${totalCount}. ` + `Use offset=${toEntry + 1} to continue.`;
			} else {
				status = `End of listing — ${totalCount} entries total.`;
			}

			return {
				content: [{ type: "text", text: status }],
				details: entries,
			};
		},
	};
}
