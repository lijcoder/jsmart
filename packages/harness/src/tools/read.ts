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
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export function createReadTool(fs: FsProvider, options?: CreateFsToolsOptions): AgentTool<typeof readToolSchema> {
	const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
	const maxLineLength = options?.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
	return {
		name: "read",
		label: "Read",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.",
		parameters: readToolSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			_signal?: AbortSignal,
		) => {
			const resolved = fs.resolvePath(path);

			// Binary check by extension
			if (help.isBinaryPath(resolved)) {
				throw new Error(`Cannot read binary file: ${resolved}`);
			}

			let content: string;
			try {
				content = await fs.readFile(resolved);
			} catch (error: unknown) {
				if (error && typeof error === "object" && "name" in error && error.name === "FileTooLargeError") {
					throw new Error((error as Error).message);
				}
				throw error;
			}

			const allLines = content.split("\n");
			const totalLines = allLines.length;
			const lineLimit = limit ?? maxLines;
			const start = (offset ?? 1) - 1; // convert 1-based to 0-based

			if (start > 0 && start >= totalLines) {
				throw new Error(`Offset ${offset} is out of range (file has ${totalLines} lines)`);
			}

			const end = Math.min(start + lineLimit, totalLines);
			const slice = allLines.slice(start, end);

			// Truncate long lines and cap total bytes
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
				outputLines.push(`${start + i + 1}: ${line}`);
			}

			const lastLine = start + outputLines.length;
			const hasMore = lastLine < totalLines;

			let status: string;
			if (truncatedByBytes) {
				status =
					`Output capped at ${help.formatBytes(maxOutputBytes)}. ` +
					`Showing lines ${start + 1}-${lastLine} of ${totalLines}. ` +
					`Use offset=${lastLine + 1} to continue.`;
			} else if (hasMore) {
				status =
					`Showing lines ${start + 1}-${lastLine} of ${totalLines}. ` + `Use offset=${lastLine + 1} to continue.`;
			} else {
				status = `End of file — ${totalLines} lines total.`;
			}

			return {
				content: [{ type: "text", text: outputLines.join("\n") }],
				details: {
					filePath: resolved,
					totalLines,
					fromLine: start + 1,
					toLine: lastLine,
					status,
				},
			};
		},
	};
}
