import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { Type } from "@sinclair/typebox";
import type { FsProvider } from "../providers/types.js";
import type { CreateFsToolsOptions } from "./help.js";
import * as help from "./help.js";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export function createWriteTool(fs: FsProvider, _options?: CreateFsToolsOptions): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			{ path, content }: { path: string; content: string },
			_signal?: AbortSignal,
		) => {
			const resolved = fs.resolvePath(path);
			await fs.mkdir(help.dirname(resolved), { recursive: true });
			await fs.writeFile(resolved, content);
			return {
				content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${resolved}` }],
				details: undefined,
			};
		},
	};
}
