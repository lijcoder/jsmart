export interface UIToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: "pending" | "running" | "done" | "error";
	result?: unknown;
}

export interface UIContentBlock {
	type: "text" | "user_text" | "thinking" | "tool_call";
	text?: string;
	toolCall?: UIToolCall;
}

export interface UIMessage {
	id: string;
	role: "user" | "assistant";
	blocks: UIContentBlock[];
}
