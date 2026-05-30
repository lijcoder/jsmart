import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { Type } from "@sinclair/typebox";
import type { FsProvider } from "../providers/types.js";
import type { CreateFsToolsOptions } from "./help.js";
import * as help from "./help.js";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Full content to write to the file" }),
});

export function createWriteTool(fs: FsProvider, _options?: CreateFsToolsOptions): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file, creating it if it does not exist or fully overwriting it if it does. Parent directories are created automatically.\n\n" +
			"Use this to create new files. For modifying existing files, prefer edit (surgical replacement) to avoid accidentally overwriting content. " +
			"Only use write on an existing file when you intend a complete rewrite — and only after confirming via read that you have the full current content.",
		parameters: writeSchema,
		execute: async (_toolCallId: string, { path, content }: { path: string; content: string }) => {
			const resolved = fs.resolvePath(path);
			const existed = await fs.exists(resolved);

			await fs.mkdir(help.dirname(resolved), { recursive: true });
			await fs.writeFile(resolved, content);

			const bytes = Buffer.byteLength(content, "utf-8");
			const lines = content.split("\n").length;
			const action = existed ? "Overwrote" : "Created";

			return {
				content: [{ type: "text", text: `${action} ${path} — ${lines} lines, ${help.formatBytes(bytes)}.` }],
				details: { filePath: resolved, lines, bytes },
			};
		},
	};
}
