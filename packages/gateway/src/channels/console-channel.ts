import type { AgentSessionEvent } from "@jsmart/jsmart-harness";
import * as readline from "readline";
import type { Route } from "../config.js";
import type { ChannelFactory } from "./registry.js";
import { registerChannelFactory } from "./registry.js";
import type { Channel, MessageSource, OnMessage } from "./types.js";

type ThemeItem = { bg: string; fg: string; text: string };

const color = {
	info: { bg: "\x1b[47m", fg: "\x1b[30m", text: " 信息 " },
	success: { bg: "\x1b[42m", fg: "\x1b[97m", text: " 成功 " },
	warning: { bg: "\x1b[43m", fg: "\x1b[30m", text: " 警告 " },
	error: { bg: "\x1b[41m", fg: "\x1b[97m", text: " 错误 " },
	muted: { bg: "\x1b[0m", fg: "\x1b[90m", text: " 次要 " },
};
const colorReset = "\x1b[0m";

function colorText(text: string, c: ThemeItem): string {
	return `${c.bg}${c.fg}${text}${colorReset}`;
}

export interface ConsoleChannelOptions {
	/** Show tool execution details */
	showTools?: boolean;
	/** Routes for this channel — must define sessionId */
	routes: Route[];
}

export class ConsoleChannel implements Channel {
	readonly id = "console";

	private rl?: readline.Interface;
	private showTools: boolean;
	private onMessage?: OnMessage;
	private routes: Route[];

	constructor(options: ConsoleChannelOptions) {
		this.showTools = options.showTools ?? true;
		this.routes = options.routes;
	}

	async start(onMessage: OnMessage): Promise<void> {
		this.onMessage = onMessage;

		// Start readline input loop
		this.rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		this._promptLoop();
	}

	async stop(): Promise<void> {
		this.onMessage = undefined;
		this.rl?.close();
		this.rl = undefined;
	}

	async sendEvent(_source: MessageSource, event: AgentSessionEvent): Promise<void> {
		switch (event.type) {
			case "agent_start":
				process.stdout.write(`${colorText("Agent", color.info)} Started\n`);
				break;

			case "agent_end":
				process.stdout.write(`${colorText("Agent", color.info)} Finished\n`);
				break;

			case "turn_start":
				process.stdout.write(`${colorText("Turn", color.muted)} Starting...\n`);
				break;

			case "turn_end":
				process.stdout.write(`${colorText("Turn", color.muted)} Finished\n`);
				break;

			case "message_start":
				if (event.message.role === "assistant") {
					process.stdout.write(`${colorText("Assistant", color.info)} Thinking...\n`);
				}
				break;

			case "message_update":
				// Streaming updates — skip for console to avoid flicker
				break;

			case "message_end": {
				if (event.message.role === "assistant") {
					const text = this._extractText(event.message.content);
					if (text) {
						process.stdout.write(`${colorText("Assistant", color.success)} ${text}\n`);
					}
					if (event.message.stopReason === "error") {
						const errMsg = event.message.errorMessage ?? "Unknown error";
						process.stdout.write(`${colorText("Error", color.error)} ${errMsg}\n`);
					}
					if (event.message.stopReason === "length") {
						process.stdout.write(`${colorText("Error", color.error)} Message length exceeds limit\n`);
					}
				}
				break;
			}

			case "tool_execution_start":
				if (this.showTools) {
					process.stdout.write(`${colorText("Tool", color.muted)} ▶ ${event.toolName}\n`);
				}
				break;

			case "tool_execution_update":
				// Partial tool updates — skip for console
				break;

			case "tool_execution_end":
				if (this.showTools) {
					const status = event.isError ? colorText("✖", color.error) : colorText("✔", color.success);
					process.stdout.write(`${colorText("Tool", color.muted)} ${status} ${event.toolName}\n`);
				}
				break;
		}
	}

	private _extractText(content?: { type: string; text?: string }[]): string {
		if (!content) return "";
		return content
			.filter((p) => p.type === "text")
			.map((p) => p.text ?? "")
			.join("");
	}

	private _promptLoop(): void {
		if (!this.rl) return;

		// Use the first route with an empty match (console convention: match all)
		const route = this.routes.find((r) => Object.keys(r.match).length === 0) ?? this.routes[0];
		if (!route) {
			process.stdout.write(`${colorText("Error", color.error)} No matching route for console\n`);
			return;
		}

		if (!route.sessionId) {
			process.stdout.write(`${colorText("Error", color.error)} Console route "${route.id}" must define sessionId\n`);
			return;
		}

		const source: MessageSource = {
			channelId: this.id,
			routeId: route.id,
			sessionId: route.sessionId,
		};

		this.rl.question("> ", (answer) => {
			const command = answer.trim().toLowerCase();

			if (command === "/quit") {
				this.stop().catch(console.error);
				return;
			}

			if (answer.trim()) {
				this.onMessage?.(source, answer.trim()).catch(console.error);
			}

			this._promptLoop();
		});
	}
}

/** Factory for creating ConsoleChannel from config */
export const ConsoleChannelFactory: ChannelFactory<ConsoleChannelOptions> = {
	type: "console",
	create: (config) => new ConsoleChannel(config),
};

// Auto-register on import
registerChannelFactory(ConsoleChannelFactory);
