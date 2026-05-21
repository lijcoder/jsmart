import type { AssistantMessage } from "@jsmart/jsmart-ai";
import type { AgentSessionEvent } from "@jsmart/jsmart-harness";
import * as Lark from "@larksuiteoapi/node-sdk";
import { randomUUID } from "crypto";
import { createReadStream, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { basename, extname, join } from "path";
import type { Route } from "../../config.js";
import { logger } from "../../logger.js";
import type { ChannelFactory } from "../registry.js";
import { registerChannelFactory } from "../registry.js";
import type { Channel, MessageContent, MessageSource, OnMessage } from "../types.js";

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
					"im.message.reaction.created_v1": (_data) => {},
					"im.message.receive_v1": async (data) => {
						const eventId = data.event_id;
						const rawContent = data.message?.content?.trim();
						const messageType = data.message?.message_type;
						const chatId = data.message?.chat_id;
						const messageId = data.message?.message_id;
						const threadId = data.message?.thread_id;

						logger.info(
							"[Feishu] original Message received: chatId=%s, threadId=%s, messageId=%s, type=%s, content=%s",
							chatId,
							threadId,
							messageId,
							messageType,
							rawContent,
						);

						if (!rawContent || !messageId || !chatId) return;
						if (eventId && this._hasEventId(eventId)) return;

						if (eventId) {
							this._recordEventId(eventId);
						}

						// Resolve message text — downloads resources for non-text types
						const resolveResult = await this._resolveMessageContent(messageType, rawContent, messageId);
						if (!resolveResult.success) {
							logger.error("[Feishu] Message resolution failed: %s", resolveResult.error);
							await this._sendText({ chatId, messageId }, `[Error] ${resolveResult.error}`, false);
							return;
						}
						const content = resolveResult.content;

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
						await this._addReaction({ chatId, messageId }, "Get");

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

	/**
	 * Resolve the text content of an incoming message.
	 * - Text messages: extracts the "text" field from the JSON content.
	 * - Image/file/audio/media messages: downloads the resource, saves to a temp
	 *   file, and returns a description with the file path for the agent.
	 */
	private async _resolveMessageContent(
		messageType: string,
		rawContent: string,
		messageId: string,
	): Promise<{ success: true; content: MessageContent } | { success: false; error: string }> {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(rawContent);
		} catch {
			return { success: true, content: { type: "text", text: rawContent } };
		}

		// Text message: extract the text field
		if (messageType === "text") {
			const text = parsed.text && typeof parsed.text === "string" ? parsed.text : rawContent;
			return { success: true, content: { type: "text", text } };
		}

		// File message: download the file
		if (messageType === "file") {
			const fileKey = parsed.file_key as string | undefined;
			if (!fileKey) {
				return { success: true, content: { type: "text", text: rawContent } };
			}

			const fileName = (parsed.file_name as string) || `feishu_file_${randomUUID()}`;
			const result = await this._downloadFile(fileKey, fileName, tmpdir(), messageId);

			if (!result.success) {
				return { success: false, error: `Failed to download file ${fileName}: ${result.error}` };
			}

			return { success: true, content: { type: "file", filePath: result.filePath, fileName } };
		}

		// For unsupported types, return as text
		return { success: true, content: { type: "text", text: rawContent } };
	}

	private async _downloadFile(
		fileKey: string,
		fileName: string,
		filePath: string,
		messageId: string,
	): Promise<{ success: true; filePath: string } | { success: false; error: string }> {
		if (!existsSync(filePath)) {
			mkdirSync(filePath, { recursive: true });
		}
		const fileFullPath = join(filePath, fileName);
		try {
			const res = await this.client?.im.v1.messageResource.get({
				params: {
					type: "file",
				},
				path: {
					message_id: messageId,
					file_key: fileKey,
				},
			});
			if (!res) {
				return { success: false, error: "client not available" };
			}
			await res.writeFile(fileFullPath);
			return { success: true, filePath: fileFullPath };
		} catch (e) {
			const errMsg = this._extractApiError(e);
			logger.error("[Feishu] Failed to download file: %s", errMsg);
			return { success: false, error: errMsg };
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

	private async _sendText(meta: FeishuMeta, content: string, status?: boolean, usage?: string): Promise<void> {
		if (!content.trim() || !this.client) return;

		const cardMessage =
			status === false ? this._buildCardMessageError(content, usage) : this._buildCardMessage(content, usage);
		const msgContent = JSON.stringify(cardMessage);

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

	/** Upload and send a file or image via sendMedia tool */
	private async _sendMedia(meta: FeishuMeta, filePath: string, type: string): Promise<void> {
		if (!this.client) return;

		if (!existsSync(filePath)) {
			logger.error("[Feishu] sendMedia file not found: %s", filePath);
			await this._sendText(meta, `[Error] File not found: ${filePath}`, false);
			return;
		}

		try {
			if (type === "image") {
				const res = await this.client.im.v1.image.create({
					data: {
						image_type: "message",
						image: createReadStream(filePath),
					},
				});
				if (!res?.image_key) {
					await this._sendText(meta, "[Error] Image upload failed: no image_key returned", false);
					return;
				}
				await this._sendContent(meta, "image", JSON.stringify({ image_key: res.image_key }));
			} else {
				const fileName = basename(filePath);
				const res = await this.client.im.v1.file.create({
					data: {
						file_type: this._getFileType(extname(filePath)),
						file_name: fileName,
						file: createReadStream(filePath),
					},
				});
				if (!res?.file_key) {
					await this._sendText(meta, "[Error] File upload failed: no file_key returned", false);
					return;
				}
				await this._sendContent(meta, "file", JSON.stringify({ file_key: res.file_key }));
			}
		} catch (err) {
			logger.error("[Feishu] sendMedia failed: %s", err);
			await this._sendText(meta, `[Error] sendMedia failed: ${this._extractApiError(err)}`, false);
		}
	}

	/** Send a content message (image/file) to a chat or thread */
	private async _sendContent(meta: FeishuMeta, msgType: string, content: string): Promise<void> {
		if (!this.client) return;

		if (meta.threadId) {
			await this.client.im.message.reply({
				path: { message_id: meta.messageId },
				data: {
					reply_in_thread: true,
					content,
					msg_type: msgType,
				},
			});
		} else {
			await this.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: meta.chatId,
					content,
					msg_type: msgType,
				},
			});
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

		// Handle sendMedia tool execution: upload and send file/image
		if (event.type === "tool_execution_end" && event.toolName === "sendMedia" && !event.isError) {
			const details = event.result?.details as { path?: string; type?: string } | undefined;
			if (details?.path && details?.type) {
				await this._sendMedia(meta, details.path, details.type);
			}
			return;
		}

		// Send "failed" reaction + error text if the last assistant message has an error.
		// Otherwise send "done" reaction. Always release the session.
		if (event.type === "agent_end") {
			// Calculate total token usage from all assistant messages in this run
			const usage = this._buildUsageText(event.messages);

			// Check the last message for error info. We have to wait until the end of the agent run to know if there were any errors,
			const lastMsg = event.messages[event.messages.length - 1];
			if (lastMsg && lastMsg.role === "assistant") {
				if (lastMsg.stopReason === "length" || lastMsg.stopReason === "error" || lastMsg.stopReason === "aborted") {
					const errMsg = `[Error](${lastMsg.stopReason}) ${lastMsg.errorMessage ?? ""}`;
					await this._sendText(meta, errMsg, false, usage);
				} else if (lastMsg.stopReason === "stop") {
					const finalMsg = this._extractText(lastMsg.content);
					if (finalMsg) {
						await this._sendText(meta, finalMsg, true, usage);
					} else {
						await this._sendText(meta, `[No text content to display]`, false, usage);
					}
				}
			} else {
				await this._sendText(meta, `[last message role isn't assistant, it's ${lastMsg.role}]`, false, usage);
			}
			// send done reaction
			if (meta.messageId) {
				await this._addReaction(meta, "DONE");
			}
			// Release the session so new messages can be processed.
			this.activeSources.delete(source.sessionId);
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

	/** Sum token usage from all assistant messages in an agent run */
	private _buildUsageText(messages: { role: string }[]): string {
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalTokens = 0;
		let totalCost = 0;

		for (const msg of messages) {
			if (msg.role === "assistant") {
				const usage = (msg as AssistantMessage).usage;
				if (usage) {
					totalInput += usage.input;
					totalOutput += usage.output;
					totalCacheRead += usage.cacheRead;
					totalCacheWrite += usage.cacheWrite;
					totalTokens += usage.totalTokens;
					totalCost += usage.cost.total;
				}
			}
		}

		const parts: string[] = [];
		parts.push(`Input: ${totalInput}`);
		parts.push(`Output: ${totalOutput}`);
		parts.push(`CacheRead: ${totalCacheRead}`);
		parts.push(`CacheWrite: ${totalCacheWrite}`);
		parts.push(`Total: ${totalTokens}`);
		parts.push(`Cost: $${totalCost.toFixed(6)}`);

		return parts.join(" | ");
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

	private _buildCardMessageError(text: string, usage?: string): unknown {
		return this._doBuildCardMessage(text, "red", usage);
	}

	private _buildCardMessage(text: string, usage?: string): unknown {
		return this._doBuildCardMessage(text, "blue", usage);
	}

	private _doBuildCardMessage(text: string, template: string, subtitle?: string): unknown {
		const header: Record<string, unknown> = {
			title: { tag: "plain_text", content: "JSmart" },
			template: template,
		};
		if (subtitle) {
			header.subtitle = { tag: "plain_text", content: subtitle };
		}
		return {
			schema: "2.0",
			config: { width_mode: "fill" },
			header,
			body: {
				elements: [{ tag: "markdown", content: text }],
			},
		};
	}

	/** Map file extension to Feishu file type for im.v1.file.create */
	private _getFileType(ext: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
		switch (ext.toLowerCase()) {
			case ".opus":
				return "opus";
			case ".mp4":
				return "mp4";
			case ".pdf":
				return "pdf";
			case ".doc":
			case ".docx":
				return "doc";
			case ".xls":
			case ".xlsx":
				return "xls";
			case ".ppt":
			case ".pptx":
				return "ppt";
			default:
				return "stream";
		}
	}
}

/** Factory for creating FeishuChannel from config */
export const FeishuChannelFactory: ChannelFactory<FeishuChannelOptions> = {
	type: "feishu",
	create: (config) => new FeishuChannel(config),
};

// Auto-register on import
registerChannelFactory(FeishuChannelFactory);
