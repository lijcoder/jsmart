import type { AgentEvent } from "@jsmart/jsmart-agent-core";

// ── Theme & Colors ─────────────────────────────────────────────────

type ThemeItem = { bg: string; fg: string; text: string };

const color = {
	tool: { bg: "\x1b[43m", fg: "\x1b[30m", text: "Tool" },
	result: { bg: "\x1b[42m", fg: "\x1b[97m", text: "Result" },
	thinking: { bg: "\x1b[47m", fg: "\x1b[30m", text: "Thinking" },
	error: { bg: "\x1b[41m", fg: "\x1b[97m", text: "Error" },
	user: { bg: "\x1b[44m", fg: "\x1b[97m", text: "User" },
};

const colorReset = "\x1b[0m";

function colorText(text: string, theme: ThemeItem): string {
	return `${theme.bg}${theme.fg}${text}${colorReset}`;
}

function colorFg(text: string, fgColor: string): string {
	return `${fgColor}${text}${colorReset}`;
}

/** Format tool args for display - shows key info concisely */
function formatToolArgs(_toolName: string, args: Record<string, unknown>): string {
	return JSON.stringify(args, null, 2);
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
			if (event.message.role === "assistant") {
				const reason = event.message.stopReason;
				if (reason === "error") {
					process.stdout.write(`\n${colorText("Error", color.error)} ${event.message.errorMessage}\n`);
				} else if (reason === "length") {
					process.stdout.write(`\n${colorText("Length", color.error)} Output truncated (max tokens reached)\n`);
				} else if (reason === "aborted") {
					process.stdout.write(`\n${colorText("Aborted", color.error)} Agent run was cancelled\n`);
				}
			}
			break;

		case "tool_execution_start":
			process.stdout.write(`\n${colorText("Tool", color.tool)}: ${event.toolName}\n`);
			process.stdout.write(`${formatToolArgs(event.toolName, event.args)}\n`);
			break;

		case "tool_execution_end":
			if (event.isError) {
				process.stdout.write(`State: ${colorFg("error", "\x1b[31m")}\n${JSON.stringify(event.result, null, 2)}\n`);
			} else {
				process.stdout.write(`State: ${colorFg("success", "\x1b[32m")}\n`);
			}
			break;

		case "agent_end": {
			// 提取 event的messages的最后一条消息
			const lastMessage = event.messages[event.messages.length - 1];
			if (lastMessage.role === "assistant") {
				const reason = lastMessage.stopReason;
				if (reason === "error") {
					process.stdout.write(`\n${colorText("Error", color.error)} ${lastMessage.errorMessage}\n`);
				} else if (reason === "length") {
					process.stdout.write(`\n${colorText("Length", color.error)} Output truncated (max tokens reached)\n`);
				} else if (reason === "aborted") {
					process.stdout.write(`\n${colorText("Aborted", color.error)} Agent run was cancelled\n`);
				}
			}
			break;
		}
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
	}
}

/** Utility: colorize text for CLI output */
export function colorize(text: string, theme: keyof typeof color): string {
	return colorText(text, color[theme]);
}
