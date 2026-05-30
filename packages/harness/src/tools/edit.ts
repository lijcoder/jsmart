import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { Type } from "@sinclair/typebox";
import type { FsProvider } from "../providers/types.js";
import type { CreateFsToolsOptions } from "./help.js";

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({
		description:
			"Exact text to find and replace — must match the file content character-for-character, including indentation and whitespace",
	}),
	newText: Type.String({ description: "Replacement text" }),
	replaceAll: Type.Optional(
		Type.Boolean({ description: "Replace all occurrences. Default false (only the first occurrence)." }),
	),
});

function lineRangeOf(content: string, matchPos: number, matchText: string): { from: number; to: number } {
	const from = content.slice(0, matchPos).split("\n").length;
	const to = from + matchText.split("\n").length - 1;
	return { from, to };
}

export function createEditTool(fs: FsProvider, _options?: CreateFsToolsOptions): AgentTool<typeof editSchema> {
	return {
		name: "edit",
		label: "Edit",
		description:
			"Edit a file by replacing an exact text match. Always read the file first — edits fail if oldText does not exactly match the current file content (including indentation and whitespace).\n\n" +
			"If oldText appears more than once, only the first occurrence is replaced. " +
			"Before calling, check whether oldText is unique in the file — use replaceAll=true if you intend to replace all occurrences. " +
			"The response shows the line range of the replacement so you can verify the edit landed in the right place.",
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{
				path,
				oldText,
				newText,
				replaceAll = false,
			}: { path: string; oldText: string; newText: string; replaceAll?: boolean },
		) => {
			const resolved = fs.resolvePath(path);
			const content = await fs.readFile(resolved);

			if (!content.includes(oldText)) {
				return {
					content: [
						{
							type: "text",
							text:
								`Edit failed: oldText not found in ${path}\n\n` +
								"Common causes:\n" +
								"- File was modified since last read — re-read and use the current content\n" +
								"- Indentation or whitespace mismatch — copy oldText exactly from the read output\n\n" +
								"Re-read the file and retry.",
						},
					],
					details: undefined,
				};
			}

			const occurrences = content.split(oldText).length - 1;
			const matchPos = content.indexOf(oldText);
			const { from, to } = lineRangeOf(content, matchPos, oldText);

			const updated = replaceAll ? content.replaceAll(oldText, newText) : content.replace(oldText, newText);
			await fs.writeFile(resolved, updated);

			const replaced = replaceAll ? occurrences : 1;
			const message = `Replaced ${replaced} occurrence${replaced > 1 ? "s" : ""} in ${path} (lines ${from}–${to}).`;

			return {
				content: [{ type: "text", text: message }],
				details: { filePath: resolved, fromLine: from, toLine: to, replaced },
			};
		},
	};
}
