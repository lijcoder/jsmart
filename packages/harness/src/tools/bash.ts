import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { Type } from "@sinclair/typebox";
import type { FsProvider, ShellProvider } from "../providers/types.js";

const bashSchema = Type.Object({
	command: Type.String({
		description: "The bash command to execute.",
	}),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Timeout in seconds (default 30s). For long-running operations like builds or installs, set to 120 or higher.",
		}),
	),
	tail: Type.Optional(
		Type.Boolean({
			description:
				"When output is truncated, keep the tail (true, default) or the head (false). Use false when errors appear at the start of output, e.g. compilation failures.",
		}),
	),
});

const MAX_STDOUT_BYTES = 50 * 1024; // 50KB
const MAX_STDERR_BYTES = 10 * 1024; // 10KB

interface TruncateResult {
	text: string;
	truncated: boolean;
	originalBytes: number;
}

function truncateBytes(text: string, maxBytes: number, keepTail: boolean): TruncateResult {
	const buf = Buffer.from(text, "utf8");
	const originalBytes = buf.byteLength;
	if (originalBytes <= maxBytes) {
		return { text, truncated: false, originalBytes };
	}
	const slice = keepTail ? buf.subarray(buf.byteLength - maxBytes) : buf.subarray(0, maxBytes);
	return { text: slice.toString("utf8"), truncated: true, originalBytes };
}

async function saveTempFile(fs: FsProvider, stdout: string, stderr: string): Promise<string> {
	const content = stderr.trim() ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
	const hash = createHash("sha1").update(content).digest("hex").slice(0, 8);
	const path = join(tmpdir(), `bash_output_${hash}.txt`);
	await fs.writeFile(path, content);
	return path;
}

export function createBashTool(shell: ShellProvider, fs: FsProvider): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command. Use dedicated tools (read file, search code, etc.) when available — only fall back to bash when no dedicated tool fits.

Rules:
- Chain dependent commands with && (stops on failure); use ; only when failure of earlier steps is acceptable
- Quote paths that may contain spaces
- Avoid interactive commands (vim, less, read, ssh)
- Pre-filter large output with grep / head / tail before it reaches the output limit

Returns: first line is [exit N] where 0 = success. stderr (if non-empty) follows after "--- stderr ---". Output exceeding ${MAX_STDOUT_BYTES / 1024}KB is truncated; the full output path is shown at the end.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout, tail = true }: { command: string; timeout?: number; tail?: boolean },
		) => {
			const timeoutMs = timeout != null ? timeout * 1000 : 30_000;
			const result = await shell.exec(command, { timeout: timeoutMs });

			const parts: string[] = [];

			// Exit code on the first line so the LLM immediately knows success/failure
			parts.push(`[exit ${result.exitCode}]`);

			// stdout (truncated)
			const stdout = truncateBytes(result.stdout, MAX_STDOUT_BYTES, tail);
			if (stdout.text.trim()) {
				parts.push(stdout.text);
			}

			// stderr — only include when non-empty
			const hasStderr = result.stderr.trim().length > 0;
			if (hasStderr) {
				const stderr = truncateBytes(result.stderr, MAX_STDERR_BYTES, tail);
				parts.push("--- stderr ---");
				parts.push(stderr.text);
			}

			// Truncation notice with full-output path
			if (stdout.truncated) {
				const tempPath = await saveTempFile(fs, result.stdout, result.stderr);
				const direction = tail ? "tail" : "head";
				parts.push(
					`\n(stdout truncated: showing ${direction} ${MAX_STDOUT_BYTES / 1024}KB of ${(stdout.originalBytes / 1024).toFixed(1)}KB — full output: ${tempPath})`,
				);
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { exitCode: result.exitCode },
			};
		},
	};
}
