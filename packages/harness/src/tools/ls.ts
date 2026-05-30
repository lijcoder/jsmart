import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { Type } from "@sinclair/typebox";
import type { FsProvider } from "../providers/types.js";
import * as help from "./help.js";
import { type CreateFsToolsOptions, DEFAULT_MAX_OUTPUT_BYTES } from "./help.js";

const lsSchema = Type.Object({
	dirPath: Type.Optional(Type.String({ description: "Directory path to list (defaults to cwd)" })),
	offset: Type.Optional(Type.Number({ description: "1-based entry number to start listing from" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default 100)" })),
});

const DEFAULT_LIMIT = 100;

export function createLsTool(fs: FsProvider, _options?: CreateFsToolsOptions): AgentTool<typeof lsSchema> {
	return {
		name: "ls",
		label: "ls",
		description:
			"List directory contents. Directories appear first with a trailing '/', followed by files, both in alphabetical order. Includes dotfiles.\n\n" +
			"Use to explore project structure. For searching file contents, use grep. After locating a file, use read to view it. " +
			`Output is limited to ${DEFAULT_LIMIT} entries — use offset to page through large directories.`,
		parameters: lsSchema,
		execute: async (
			_toolCallId: string,
			{ dirPath, offset, limit }: { dirPath?: string; offset?: number; limit?: number },
		) => {
			const resolved = fs.resolvePath(dirPath ?? ".");

			const fsEntries = await fs.readdir(resolved);

			// Directories first, then files — alphabetical within each group
			const dirs = fsEntries
				.filter((e) => e.isDirectory)
				.map((e) => e.name)
				.sort();
			const files = fsEntries
				.filter((e) => !e.isDirectory)
				.map((e) => e.name)
				.sort();
			const sorted = [
				...dirs.map((n) => ({ name: n, isDir: true })),
				...files.map((n) => ({ name: n, isDir: false })),
			];

			const totalCount = sorted.length;
			const start = (offset ?? 1) - 1;
			const entryLimit = limit ?? DEFAULT_LIMIT;

			if (start > 0 && start >= totalCount) {
				return {
					content: [
						{
							type: "text",
							text: `Offset ${offset} is out of range — directory has ${totalCount} entries.`,
						},
					],
					details: [],
				};
			}

			const end = Math.min(start + entryLimit, totalCount);
			const page = sorted.slice(start, end);

			// Cap by bytes using display representation
			let totalBytes = 0;
			let truncatedByBytes = false;
			const entries: { name: string; type: "file" | "directory" }[] = [];

			for (const item of page) {
				const display = item.isDir ? `${item.name}/` : item.name;
				const itemBytes = Buffer.byteLength(display, "utf-8");
				if (totalBytes + itemBytes > DEFAULT_MAX_OUTPUT_BYTES) {
					truncatedByBytes = true;
					break;
				}
				totalBytes += itemBytes;
				entries.push({ name: item.name, type: item.isDir ? "directory" : "file" });
			}

			const fromEntry = entries.length > 0 ? start + 1 : 0;
			const toEntry = start + entries.length;
			const hasMore = toEntry < totalCount;

			let status: string;
			if (totalCount === 0) {
				status = "Directory is empty.";
			} else if (truncatedByBytes) {
				status =
					`Output capped at ${help.formatBytes(DEFAULT_MAX_OUTPUT_BYTES)}, ` +
					`showing entries ${fromEntry}–${toEntry} of ${totalCount} — use offset=${toEntry + 1} to continue.`;
			} else if (hasMore) {
				status = `Showing entries ${fromEntry}–${toEntry} of ${totalCount} — use offset=${toEntry + 1} to continue.`;
			} else {
				status = `End of listing — ${totalCount} entries total.`;
			}

			const lines = entries.map((e) => (e.type === "directory" ? `${e.name}/` : e.name));
			const text = lines.length > 0 ? `${lines.join("\n")}\n${status}` : status;

			return {
				content: [{ type: "text", text }],
				details: entries,
			};
		},
	};
}
