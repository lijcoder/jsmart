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

const readToolSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(
		Type.Number({
			description:
				"Line number to start reading from (1-indexed). Use this to jump to a specific area, e.g. a function you located via grep.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Number of lines to read. Defaults to 2000. Reduce when you only need a small section.",
		}),
	),
});

export function createReadTool(fs: FsProvider, options?: CreateFsToolsOptions): AgentTool<typeof readToolSchema> {
	const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
	const maxLineLength = options?.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
	return {
		name: "read",
		label: "Read",
		description: `Read a file and return its contents with line numbers (format: "N: content").

The last line of every response is a status summary showing the range read and total lines. When the file has more content, it tells you the exact offset to use next. Always check this line to know whether you have seen the full file.

Use offset to jump directly to a known line (e.g. after grep finds a match) and limit to narrow the window when you only need a small section. Output is capped at ${help.formatBytes(maxOutputBytes)} or ${maxLines} lines, whichever comes first.`,
		parameters: readToolSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
		) => {
			const resolved = fs.resolvePath(path);

			if (help.isBinaryPath(resolved)) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot read binary file: ${resolved}\nUse bash to inspect binary files (e.g. xxd, file, strings).`,
						},
					],
					details: undefined,
				};
			}

			let content: string;
			try {
				content = await fs.readFile(resolved);
			} catch (error: unknown) {
				if (error && typeof error === "object" && "name" in error && error.name === "FileTooLargeError") {
					return {
						content: [
							{
								type: "text",
								text: `File too large to read: ${resolved}\nUse offset and limit to read specific sections.`,
							},
						],
						details: undefined,
					};
				}
				throw error;
			}

			const allLines = content.split("\n");
			const totalLines = allLines.length;
			const lineLimit = limit ?? maxLines;
			const start = (offset ?? 1) - 1; // convert 1-indexed to 0-indexed

			if (start > 0 && start >= totalLines) {
				return {
					content: [
						{
							type: "text",
							text: `Offset ${offset} is out of range — file has ${totalLines} lines.`,
						},
					],
					details: undefined,
				};
			}

			const end = Math.min(start + lineLimit, totalLines);
			const slice = allLines.slice(start, end);

			// Right-align line numbers based on total line count
			const lineNumWidth = String(totalLines).length;
			const pad = (n: number) => String(n).padStart(lineNumWidth, " ");

			let totalBytes = 0;
			let truncatedByBytes = false;
			const outputLines: string[] = [];

			for (let i = 0; i < slice.length; i++) {
				let line = slice[i];
				if (line.length > maxLineLength) {
					line = `${line.slice(0, maxLineLength)}... (line truncated at ${maxLineLength} chars)`;
				}
				const lineBytes = Buffer.byteLength(line, "utf-8");
				if (totalBytes + lineBytes > maxOutputBytes) {
					truncatedByBytes = true;
					break;
				}
				totalBytes += lineBytes;
				outputLines.push(`${pad(start + i + 1)}: ${line}`);
			}

			const lastLine = start + outputLines.length;
			const hasMore = lastLine < totalLines;

			let status: string;
			if (truncatedByBytes) {
				status =
					`Output capped at ${help.formatBytes(maxOutputBytes)}, showing lines ${start + 1}–${lastLine} of ${totalLines}` +
					` — use offset=${lastLine + 1} to read more.`;
			} else if (hasMore) {
				status =
					`Showing lines ${start + 1}–${lastLine} of ${totalLines}` +
					` — use offset=${lastLine + 1} to read more.`;
			} else {
				status = `End of file — ${totalLines} lines total.`;
			}

			return {
				content: [{ type: "text", text: `${outputLines.join("\n")}\n${status}` }],
				details: {
					filePath: resolved,
					totalLines,
					fromLine: start + 1,
					toLine: lastLine,
				},
			};
		},
	};
}
