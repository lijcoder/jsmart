import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { Type } from "@sinclair/typebox";
import type { FsProvider } from "../providers/types.js";
import type { CreateFsToolsOptions } from "./help.js";

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
	replaceAll: Type.Optional(
		Type.Boolean({ description: "Replace all occurrences instead of just the first", default: false }),
	),
});

export function createEditTool(fs: FsProvider, _options?: CreateFsToolsOptions): AgentTool<typeof editSchema> {
	return {
		name: "edit",
		label: "Edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{
				path,
				oldText,
				newText,
				replaceAll,
			}: { path: string; oldText: string; newText: string; replaceAll?: boolean },
			_signal?: AbortSignal,
		) => {
			const resolved = fs.resolvePath(path);
			const content = await fs.readFile(resolved);

			if (!content.includes(oldText)) {
				throw new Error(`oldString not found in ${resolved}.`);
			}

			const updated = replaceAll ? content.replaceAll(oldText, newText) : content.replace(oldText, newText);
			await fs.writeFile(resolved, updated);

			const occurrences = content.split(oldText).length - 1;
			const replacements = replaceAll ? occurrences : 1;
			return {
				content: [{ type: "text", text: `Successfully replaced ${replacements} block(s) in ${path}.` }],
				details: undefined,
			};
		},
	};
}
