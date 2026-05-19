import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { Type } from "@sinclair/typebox";

const sendMediaSchema = Type.Object({
	path: Type.String({ description: "Absolute path to the file to send to the user" }),
	type: Type.String({ description: "File type: 'file' or 'image'" }),
});

export interface SendMediaResult {
	path: string;
	type: string;
}

export function createSendMediaTool(): AgentTool<typeof sendMediaSchema, SendMediaResult> {
	return {
		name: "sendMedia",
		label: "sendMedia",
		description: "Send a file or image to the user. The path must be an absolute path.",
		parameters: sendMediaSchema,
		execute: async (_toolCallId: string, { path, type }: { path: string; type: string }) => {
			return {
				content: [{ type: "text", text: `send success` }],
				details: { path, type },
			};
		},
	};
}
