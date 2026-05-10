import type { AgentSessionEvent } from "@jsmart/jsmart-harness";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { Route } from "../config.js";
import { logger } from "../logger.js";
import type { ChannelFactory } from "./registry.js";
import { registerChannelFactory } from "./registry.js";
import type { Channel, MessageSource, OnMessage } from "./types.js";

export interface FeishuChannelOptions {
	appId: string;
	appSecret: string;
	domain?: string;
	/** Routes for this channel — used to match incoming messages */
	routes: Route[];
}

interface FeishuMeta {
	chatId: string;
	messageId: string;
	threadId?: string;
}

export class FeishuChannel implements Channel {
	readonly id = "feishu";

	private options: FeishuChannelOptions;
	private client?: Lark.Client;
	private wsClient?: Lark.WSClient;
	private onMessage?: OnMessage;
	/** Fixed-size circular deduplication buffer: 10 event_ids */
	private readonly _processedEventIds: (string | undefined)[] = new Array(10);
	private _writeIndex = 0;

	constructor(options: FeishuChannelOptions) {
		this.options = options;
	}

	async start(onMessage: OnMessage): Promise<void> {
		this.onMessage = onMessage;

		// Setup API client
		this.client = new Lark.Client({
			appId: this.options.appId,
			appSecret: this.options.appSecret,
			domain: this.options.domain ?? "https://open.feishu.cn",
			loggerLevel: Lark.LoggerLevel.fatal,
		});

		// Setup WebSocket listener for inbound messages
		this.wsClient = new Lark.WSClient({
			appId: this.options.appId,
			appSecret: this.options.appSecret,
			domain: this.options.domain ?? "https://open.feishu.cn",
			loggerLevel: Lark.LoggerLevel.error,
		});

		try {
			this.wsClient.start({
				eventDispatcher: new Lark.EventDispatcher({}).register({
					"im.message.receive_v1": (data) => {
						const eventId = data.event_id;
						const content = data.message?.content?.trim();
						const chatId = data.message?.chat_id;
						const messageId = data.message?.message_id;
						const threadId = data.message?.thread_id;

						if (!content) return;
						if (eventId && this._hasEventId(eventId)) return;

						if (eventId) {
							this._recordEventId(eventId);
						}

						// Match route based on chatId
						const route = this._matchRoute(chatId);
						if (!route) {
							logger.warn("[Feishu] No route matched for chatId: %s", chatId);
							return;
						}

						const isThread = !!threadId;
						const threadMode = (route.threadMode as boolean | undefined) ?? false;

						// sessionId: threadMode on → "chat_id:thread_id" for threads, "chat_id" otherwise
						const sessionId = threadMode && isThread ? `${chatId}:${threadId}` : (chatId ?? route.id);

						logger.info(
							"[Feishu] Message received: chatId=%s, routeId=%s, thread=%s, sessionId=%s, content=%s",
							chatId,
							route.id,
							isThread,
							sessionId,
							content,
						);

						const source: MessageSource = {
							channelId: this.id,
							routeId: route.id,
							sessionId,
							metadata: {
								chatId,
								messageId,
								threadId: threadId || undefined,
							},
						};

						// Fire-and-forget: return immediately so SDK sends ACK to Feishu
						this.onMessage?.(source, content).catch((err) => {
							logger.error("[Feishu] Message handling failed: %s", err);
						});
					},
				}),
			});
		} catch (error) {
			logger.error("[Feishu] WSClient failed to start: %s", error);
		}
	}

	async stop(): Promise<void> {
		this.onMessage = undefined;
		this.wsClient?.close({ force: true });
		this.wsClient = undefined;
		this.client = undefined;
	}

	private async _sendText(meta: FeishuMeta, content: string): Promise<void> {
		if (!content.trim() || !this.client) return;

		const msgContent = JSON.stringify(buildCardMessage(content));

		if (meta.threadId) {
			await this.client.im.message.reply({
				path: { message_id: meta.messageId },
				data: {
					reply_in_thread: true,
					content: msgContent,
					msg_type: "interactive",
				},
			});
		} else {
			await this.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: meta.chatId,
					content: msgContent,
					msg_type: "interactive",
				},
			});
		}
	}

	async sendEvent(source: MessageSource, event: AgentSessionEvent): Promise<void> {
		// Feishu channel only sends final assistant text messages.
		// Thinking, tool calls, and intermediate events are not forwarded.
		if (event.type !== "message_end") return;
		if (event.message.role !== "assistant") return;

		const rawMeta = source.metadata as FeishuMeta | undefined;
		const meta: FeishuMeta = {
			chatId: rawMeta?.chatId ?? source.sessionId,
			messageId: rawMeta?.messageId ?? "",
			threadId: rawMeta?.threadId,
		};

		const text = this._extractText(event.message.content);
		if (text) {
			await this._sendText(meta, text);
		}
		if (event.message.stopReason === "error") {
			const errMsg = event.message.errorMessage ?? "Unknown error";
			await this._sendText(meta, `[Error] ${errMsg}`);
		}
		if (event.message.stopReason === "length") {
			await this._sendText(meta, "[Error] Message length exceeds limit.");
		}
	}

	private _extractText(content?: { type: string; text?: string }[]): string {
		if (!content) return "";
		return content
			.filter((p) => p.type === "text")
			.map((p) => p.text ?? "")
			.join("");
	}

	/** Find the first route matching the given chatId */
	private _matchRoute(chatId: string | undefined): Route | undefined {
		for (const route of this.options.routes) {
			const matchChatId = route.match.chatId as string | undefined;
			if (matchChatId !== undefined && matchChatId !== chatId) continue;
			return route;
		}
		return undefined;
	}

	/** Check if an event_id was already processed */
	private _hasEventId(eventId: string): boolean {
		return this._processedEventIds.includes(eventId);
	}

	/** Record an event_id in the circular buffer (overwrites oldest when full) */
	private _recordEventId(eventId: string): void {
		this._processedEventIds[this._writeIndex] = eventId;
		this._writeIndex = (this._writeIndex + 1) % 10;
	}
}

/** Factory for creating FeishuChannel from config */
export const FeishuChannelFactory: ChannelFactory<FeishuChannelOptions> = {
	type: "feishu",
	create: (config) => new FeishuChannel(config),
};

// Auto-register on import
registerChannelFactory(FeishuChannelFactory);

function buildCardMessage(text: string): unknown {
	return {
		schema: "2.0",
		config: { width_mode: "fill" },
		header: {
			title: { tag: "plain_text", content: "AI Agent" },
			template: "blue",
		},
		body: {
			elements: [{ tag: "markdown", content: text }],
		},
	};
}
