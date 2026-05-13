import type { AgentEvent } from "@jsmart/jsmart-agent-core";

// ── Theme & Colors ─────────────────────────────────────────────────

type ThemeItem = { bg: string; fg: string; text: string };

const color = {
	tool: { bg: "\x1b[43m", fg: "\x1b[30m", text: "Tool" },
	result: { bg: "\x1b[42m", fg: "\x1b[97m", text: "Result" },
	thinking: { bg: "\x1b[47m", fg: "\x1b[30m", text: "Thinking" },
	error: { bg: "\x1b[41m", fg: "\x1b[97m", text: "Error" },
};

const colorReset = "\x1b[0m";

function colorText(text: string, theme: ThemeItem): string {
	return `${theme.bg}${theme.fg}${text}${colorReset}`;
}

function colorFg(text: string, fgColor: string): string {
	return `${fgColor}${text}${colorReset}`;
}

/** Format tool args for display - shows key info concisely */
function formatToolArgs(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "read":
			return `path: ${args.path}${args.offset ? `, offset: ${args.offset}` : ""}${args.limit ? `, limit: ${args.limit}` : ""}`;
		case "bash":
			return `command: ${args.command}`;
		case "edit":
			return `path: ${args.path}`;
		case "write":
			return `path: ${args.path}`;
		case "truncate":
			return `path: ${args.path}`;
		default:
			return JSON.stringify(args, null, 2);
	}
}

// ── Main Event Handler ─────────────────────────────────────────────

export function handleAgentEvent(event: AgentEvent): void {
	switch (event.type) {
		case "message_update":
			if (event.message.role === "assistant") {
				handleMessageUpdate(event);
			}
			break;

		case "message_end":
			if (event.message.role === "assistant" && event.message.stopReason === "error") {
				process.stdout.write(
					`\n${colorText("Error", color.error)} ${event.message.stopReason}: ${event.message.errorMessage}\n`,
				);
			}
			break;

		case "tool_execution_start":
			process.stdout.write(`\n${colorText("Tool", color.tool)}: ${event.toolName}\n`);
			process.stdout.write(`  ${formatToolArgs(event.toolName, event.args)}\n`);
			break;

		case "tool_execution_end":
			if (event.isError) {
				process.stdout.write(`State: ${colorFg("error", "\x1b[31m")}\n`);
			} else {
				process.stdout.write(`State: ${colorFg("success", "\x1b[32m")}\n`);
			}
			break;
	}
}

function handleMessageUpdate(event: Extract<AgentEvent, { type: "message_update" }>): void {
	const assistantEvent = event.assistantMessageEvent;

	switch (assistantEvent.type) {
		case "text_start":
			process.stdout.write(`\n${colorText("Result", color.result)}\n`);
			break;

		case "text_delta":
			process.stdout.write(assistantEvent.delta);
			break;

		case "text_end":
			process.stdout.write("\n");
			break;

		case "thinking_start":
			process.stdout.write(`\n${colorText("Thinking", color.thinking)} `);
			break;

		case "thinking_delta":
			process.stdout.write(colorFg(assistantEvent.delta, "\x1b[90m"));
			break;

		case "thinking_end":
			process.stdout.write("\n");
			break;

		case "error":
			process.stdout.write(
				`\n${colorText("Stream Error", color.error)} ${assistantEvent.reason}: ${assistantEvent.error.errorMessage}\n`,
			);
			break;
	}
}

/** Utility: colorize text for CLI output */
export function colorize(text: string, theme: keyof typeof color): string {
	return colorText(text, color[theme]);
}
