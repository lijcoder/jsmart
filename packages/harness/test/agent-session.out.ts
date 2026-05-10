import type { Agent, AgentEvent } from "@jsmart/jsmart-agent-core";
import type { AgentSessionEvent, AgentSessionEventListener } from "../src/agent-session.js";

type ThemeItem = { bg: string; fg: string; text: string };
const color = {
	info: { bg: "\x1b[47m", fg: "\x1b[30m", text: " 信息 " }, // 白底黑字
	success: { bg: "\x1b[42m", fg: "\x1b[97m", text: " 成功 " }, // 绿底浅白字
	warning: { bg: "\x1b[43m", fg: "\x1b[30m", text: " 警告 " }, // 黄底黑字
	error: { bg: "\x1b[41m", fg: "\x1b[97m", text: " 错误 " }, // 红底浅白字
	title: { bg: "\x1b[44m", fg: "\x1b[97m", text: " 标题 " }, // 蓝底浅白字
	muted: { bg: "\x1b[0m", fg: "\x1b[90m", text: " 次要 " }, // 灰色
};
const colorReset = "\x1b[0m";

function _colorText(text: string, color: ThemeItem): string {
	return `${color.bg}${color.fg}${text}${colorReset}`;
}

function _formatArgs(args: Record<string, unknown>): string {
	return JSON.stringify(args, null, 2);
}

function agentMessageUpdateDebug(event: AgentEvent) {
	if (event.type === "message_update") {
		switch (event.assistantMessageEvent.type) {
			case "start":
				process.stdout.write(`\n-- start --\n`);
				break;
			case "text_start":
				process.stdout.write(`\n-- text_start --\n`);
				break;
			case "text_delta":
				process.stdout.write(event.assistantMessageEvent.delta);
				break;
			case "text_end":
				process.stdout.write(`\n-- text_end --\n`);
				break;
			case "thinking_start":
				process.stdout.write(`\n-- thinking_start --\n`);
				break;
			case "thinking_delta":
				process.stdout.write(event.assistantMessageEvent.delta);
				break;
			case "thinking_end":
				process.stdout.write(`\n-- thinking_end --\n`);
				break;
			case "toolcall_start":
				break;
			case "toolcall_delta":
				break;
			case "toolcall_end":
				break;
			case "done":
				process.stdout.write(`\n-- done [${event.assistantMessageEvent.reason}] --\n`);
				break;
			case "error":
				process.stdout.write(`\n-- error [${event.assistantMessageEvent.reason}]--\n`);
				process.stdout.write(`${event.assistantMessageEvent.error.errorMessage}\n`);
				break;
		}
	}
}

export function agentSubscriberDebug(agent: Agent) {
	agent.subscribe(async (event, _signal) => {
		switch (event.type) {
			case "agent_start":
				console.log("--- agent start ---");
				break;
			case "agent_end":
				console.log(`--- agent end. 消息总数：${event.messages.length} ---`);
				break;
			case "turn_start":
				console.log("--- turn start ---");
				break;
			case "turn_end":
				event.message;
				console.log("--- turn end ---");
				break;
			case "message_start":
				if (event.message.role === "user") {
					let userPrompt = "";
					if (typeof event.message.content === "string") {
						userPrompt = event.message.content;
					} else if (Array.isArray(event.message.content)) {
						event.message.content.forEach((part) => {
							if (part.type === "text") {
								userPrompt += part.text;
							}
						});
					}
					console.log(`> ${userPrompt}`);
				}
				console.log(`--- message start [${event.message.role}] ---`);
				break;
			case "message_update":
				if (event.message.role === "assistant") {
					agentMessageUpdateDebug(event);
				}
				break;
			case "message_end":
				if (event.message.role === "assistant" && event.message.stopReason === "error") {
					console.log(`${event.message.stopReason} : `, event.message.errorMessage);
				}
				console.log(`--- message end ---`);
				break;
			case "tool_execution_start":
				console.log(`--- tool execution start [name: ${event.toolName}] ---`);
				console.log(`param: `, event.args);
				break;
			case "tool_execution_update":
				break;
			case "tool_execution_end":
				if (event.isError) {
					console.log(`tool execution error: `, event.result);
				}
				console.log(`--- tool execution end [status: ${event.isError ? "error" : "success"}] ---`);
				break;
		}
	});
}

function agentMessageUpdateFormat(event: AgentSessionEvent) {
	if (event.type === "message_update") {
		switch (event.assistantMessageEvent.type) {
			case "start":
				break;
			case "text_start":
				process.stdout.write(`${_colorText("Result", color.success)}\n`);
				break;
			case "text_delta":
				process.stdout.write(event.assistantMessageEvent.delta);
				break;
			case "text_end":
				process.stdout.write("\n");
				break;
			case "thinking_start":
				process.stdout.write(`\n${_colorText("Thinking", color.muted)} `);
				break;
			case "thinking_delta":
				process.stdout.write(_colorText(event.assistantMessageEvent.delta, color.muted));
				break;
			case "thinking_end":
				process.stdout.write("\n");
				break;
			case "toolcall_start":
				break;
			case "toolcall_delta":
				break;
			case "toolcall_end":
				break;
			case "done":
				break;
			case "error":
				break;
		}
	}
}

export const agentSubscriberFormat: AgentSessionEventListener = (event: AgentSessionEvent): void => {
	switch (event.type) {
		case "agent_start":
			break;
		case "agent_end":
			break;
		case "turn_start":
			break;
		case "turn_end":
			process.stdout.write("--------------------\n");
			break;
		case "message_start":
			// if (event.message.role === "user") {
			// 	let userPrompt = "";
			// 	if (typeof event.message.content === "string") {
			// 		userPrompt = event.message.content;
			// 	} else if (Array.isArray(event.message.content)) {
			// 		event.message.content.forEach((part) => {
			// 			if (part.type === "text") {
			// 				userPrompt += part.text;
			// 			}
			// 		});
			// 	}
			// 	process.stdout.write(`${_colorText("User", color.info)} > ${userPrompt}\n`);
			// }
			break;
		case "message_update":
			if (event.message.role === "assistant") {
				agentMessageUpdateFormat(event);
			}
			break;
		case "message_end":
			if (event.message.role === "assistant" && event.message.stopReason === "error") {
				process.stdout.write(
					`${_colorText("Error", color.error)} ${event.message.stopReason}, ${event.message.errorMessage}\n`,
				);
			}
			break;
		case "tool_execution_start":
			process.stdout.write(`${_colorText("Tool", color.warning)} ${event.toolName}\n${_formatArgs(event.args)}\n`);
			break;
		case "tool_execution_update":
			break;
		case "tool_execution_end":
			if (event.isError) {
				process.stdout.write(`status: error\n${_formatArgs(event.result)}\n`);
			} else {
				process.stdout.write(`status: success\n`);
			}
			break;
	}
};
