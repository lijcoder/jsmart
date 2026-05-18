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
	/** Maps sessionId → source for the currently running prompt in that session */
	private activeSources = new Map<string, MessageSource>();

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
					"im.message.receive_v1": async (data) => {
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

						// Reject message if the session is already running a prompt
						if (this.activeSources.has(sessionId)) {
							logger.info("[Feishu] Session %s is busy, dropping message with SLEEP reaction", sessionId);
							await this._addReaction({ chatId: chatId ?? "", messageId }, "SLEEP");
							return;
						}

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

						// Track this session as active before forwarding to gateway
						this.activeSources.set(sessionId, source);

						// Add "Get" reaction to indicate the message is being processed
						await this._addReaction({ chatId: chatId ?? "", messageId }, "Get");

						// Fire-and-forget: return immediately so SDK sends ACK to Feishu
						this.onMessage?.(source, content).catch((err) => {
							this.activeSources.delete(sessionId);
							logger.error("[Feishu] Message handling failed: %s", err);
						});
					},
				}),
			});
		} catch (error) {
			logger.error("[Feishu] WSClient failed to start: %s", error);
		}
	}

	private async _addReaction(meta: FeishuMeta, emojiType: string): Promise<void> {
		if (!this.client || !meta.messageId) return;
		try {
			await this.client.im.messageReaction.create({
				path: { message_id: meta.messageId },
				data: { reaction_type: { emoji_type: emojiType } },
			});
		} catch (err) {
			logger.error("[Feishu] Failed to add reaction %s: %s", emojiType, err);
		}
	}

	async stop(): Promise<void> {
		this.onMessage = undefined;
		this.wsClient?.close({ force: true });
		this.wsClient = undefined;
		this.client = undefined;
		this.activeSources.clear();
	}

	private async _sendText(meta: FeishuMeta, content: string): Promise<void> {
		if (!content.trim() || !this.client) return;

		const msgContent = JSON.stringify(buildCardMessage(content));

		try {
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
		} catch (error: unknown) {
			logger.error("[Feishu] Failed to send message: %s", error);
			const errMsg = this._extractApiError(error);
			await this._sendFallbackText(meta, `[Error] Send failed: ${errMsg}`);
		}
	}

	/** Extract a human-readable error message from a Lark SDK / Axios error */
	private _extractApiError(error: unknown): string {
		// Lark API errors are AxiosError with response.data containing { code, msg }
		const apiErr = error as Record<string, unknown> | undefined;
		const resp = apiErr?.response as Record<string, unknown> | undefined;
		const data = resp?.data as Record<string, unknown> | undefined;
		if (data?.msg) {
			const code = data.code ?? "?";
			return `code=${code} ${data.msg}`;
		}
		if (resp?.status) {
			return `HTTP ${resp.status} ${resp.statusText ?? ""}`;
		}
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	}

	/** Fallback plain-text send when the interactive card message fails */
	private async _sendFallbackText(meta: FeishuMeta, content: string): Promise<void> {
		if (!content.trim() || !this.client) return;

		const textContent = JSON.stringify({ text: content });

		try {
			if (meta.threadId) {
				await this.client.im.message.reply({
					path: { message_id: meta.messageId },
					data: {
						reply_in_thread: true,
						content: textContent,
						msg_type: "text",
					},
				});
			} else {
				await this.client.im.message.create({
					params: { receive_id_type: "chat_id" },
					data: {
						receive_id: meta.chatId,
						content: textContent,
						msg_type: "text",
					},
				});
			}
		} catch (fallbackErr: unknown) {
			logger.error("[Feishu] Failed to send fallback message: %s", fallbackErr);
		}
	}

	async sendEvent(source: MessageSource, event: AgentSessionEvent): Promise<void> {
		// Use the stored source for this session so metadata always matches
		// the current incoming message, not the first one that created the session.
		const effectiveSource = this.activeSources.get(source.sessionId) ?? source;
		const rawMeta = effectiveSource.metadata as FeishuMeta | undefined;
		const meta: FeishuMeta = {
			chatId: rawMeta?.chatId ?? "",
			messageId: rawMeta?.messageId ?? "",
			threadId: rawMeta?.threadId,
		};

		// Send "typing" reaction when the agent starts
		if (event.type === "agent_start" && meta.messageId) {
			await this._addReaction(meta, "Typing");
			return;
		}

		// Send "failed" reaction + error text if the last assistant message has an error.
		// Otherwise send "done" reaction. Always release the session.
		if (event.type === "agent_end") {
			// Check the last message for error info. We have to wait until the end of the agent run to know if there were any errors,
			const lastMsg = event.messages[event.messages.length - 1];
			if (lastMsg && lastMsg.role === "assistant") {
				if (lastMsg.stopReason === "length" || lastMsg.stopReason === "error" || lastMsg.stopReason === "aborted") {
					const errMsg = `[Error](${lastMsg.stopReason}) ${lastMsg.errorMessage ?? ""}`;
					await this._sendText(meta, errMsg);
				}
			}
			// send done reaction
			if (meta.messageId) {
				await this._addReaction(meta, "DONE");
			}
			// Release the session so new messages can be processed.
			this.activeSources.delete(source.sessionId);
			return;
		}

		// Send final assistant text message.
		// Thinking, tool calls, and intermediate events are not forwarded.
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (event.message.stopReason === "stop") {
				const finalMsg = this._extractText(event.message.content);
				if (finalMsg) {
					await this._sendText(meta, finalMsg);
				} else {
					await this._sendText(meta, "[No text content to display]");
				}
			}
			return;
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
			title: { tag: "plain_text", content: "JSmart" },
			template: "blue",
		},
		body: {
			elements: [{ tag: "markdown", content: text }],
		},
	};
}
