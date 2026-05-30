import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { Type } from "@sinclair/typebox";
import type { FsProvider } from "../providers/types.js";
import * as help from "./help.js";
import {
	type CreateFsToolsOptions,
	DEFAULT_MAX_LINE_LENGTH,
	DEFAULT_MAX_LINES,
	DEFAULT_MAX_OUTPUT_BYTES,
} from "./help.js";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Regex pattern to search for" }),
	dirPath: Type.Optional(
		Type.String({ description: "Root directory to search from (defaults to cwd)", default: "." }),
	),
	glob: Type.Optional(Type.String({ description: "Only search files matching this glob suffix (e.g. '.ts')" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive matching", default: false })),
	offset: Type.Optional(Type.Number({ description: "1-based match number to start returning from" })),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of matches to return (default ${DEFAULT_MAX_LINES})` }),
	),
});

export function createGrepTool(fs: FsProvider, _options?: CreateFsToolsOptions): AgentTool<typeof grepSchema> {
	const maxLines = DEFAULT_MAX_LINES;
	const maxLineLength = DEFAULT_MAX_LINE_LENGTH;
	const maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
	return {
		name: "grep",
		label: "Grep",
		description:
			"Search file contents with a regex pattern. Searches recursively " +
			"from the given directory, skipping node_modules and .git. " +
			"Returns matching lines with file paths and line numbers. " +
			"Large result sets are paginated automatically; use offset and limit to continue.",
		parameters: grepSchema,
		execute: async (
			_toolCallId: string,
			{
				pattern,
				dirPath,
				glob,
				ignoreCase,
				offset,
				limit,
			}: { pattern: string; dirPath?: string; glob?: string; ignoreCase?: boolean; offset?: number; limit?: number },
			_signal?: AbortSignal,
		) => {
			const useDirPath = dirPath ?? ".";
			const fileSuffix = glob;
			const resolved = fs.resolvePath(useDirPath);
			const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
			const allFiles = await help.walkFiles(fs, resolved);

			const files = fileSuffix ? allFiles.filter((f) => f.endsWith(fileSuffix)) : allFiles;

			const matches: { file: string; line: number; content: string }[] = [];
			const start = (offset ?? 1) - 1;
			const matchLimit = limit ?? maxLines;
			let matchCount = 0;
			let totalBytes = 0;
			let truncatedByBytes = false;

			for (const file of files) {
				if (help.isBinaryPath(file)) continue;

				let content: string;
				try {
					content = await fs.readFile(file);
				} catch {
					continue; // skip binary / unreadable / too-large files
				}

				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (regex.test(lines[i])) {
						matchCount += 1;

						if (matchCount <= start || truncatedByBytes || matches.length >= matchLimit) {
							continue;
						}

						const match = {
							file: help.relativePath(resolved, file),
							line: i + 1,
							content: help.truncateLine(lines[i], maxLineLength),
						};
						const matchBytes = Buffer.byteLength(JSON.stringify(match), "utf-8");

						if (totalBytes + matchBytes > maxOutputBytes) {
							truncatedByBytes = true;
							continue;
						}

						totalBytes += matchBytes;
						matches.push(match);
					}
				}
			}

			if (start > 0 && start >= matchCount) {
				throw new Error(
					`The offset value ${offset} exceeds the available matches. ` +
						`When searching for pattern "${pattern}" in directory "${resolved}", ` +
						`only ${matchCount} match(es) were found. ` +
						`Please use an offset between 0 and ${matchCount - 1}.`,
				);
			}

			const fromMatch = matches.length > 0 ? start + 1 : 0;
			const toMatch = start + matches.length;
			const hasMore = toMatch < matchCount;

			let status: string;
			if (matchCount === 0) {
				status = `No matches found for /${pattern}/.`;
			} else if (truncatedByBytes) {
				status =
					`Output capped at ${help.formatBytes(maxOutputBytes)}. ` +
					`Showing matches ${fromMatch}-${toMatch} of ${matchCount}. ` +
					`Use offset=${toMatch + 1} to continue.`;
			} else if (hasMore) {
				status =
					`Showing matches ${fromMatch}-${toMatch} of ${matchCount}. ` + `Use offset=${toMatch + 1} to continue.`;
			} else {
				status = `End of matches — ${matchCount} total.`;
			}

			return {
				content: [{ type: "text", text: status }],
				details: matches,
			};
		},
	};
}
