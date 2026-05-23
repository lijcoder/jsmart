import type { AgentSessionEvent } from "@jsmart/jsmart-harness";
import { randomUUID } from "crypto";
import fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "../..//logger.js";
import type { MessageSource, OnMessage } from "../types.js";
import { getConfig, getUpdates, sendTyping } from "./api/api.js";
import { MessageItemType, type WeixinMessage } from "./api/types.js";
import { downloadMediaFromItem } from "./media/media-download.js";
import { sendMessageWeixin } from "./messaging/send.js";
import { sendWeixinMediaFile } from "./messaging/send-media.js";

/** Account token file stored in accountsDir */
export interface WeixinAccount {
	baseurl: string;
	bot_token: string;
	ilink_bot_id: string;
	ilink_user_id: string;
}

// cdn base url
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
// typing ticket exprie 60 minutes
const DEFAULT_TYPING_INFO_EXPIRATION_MS = 60 * 60 * 1000;

const DEFAULT_ROUTE_ID = "weixin-main";
const DEFAULT_CHANNEL_ID = "weixin";

export class WeixinAccountSession {
	private account: WeixinAccount;
	private typingInfo: { typing_ticket: string | undefined; update_time: number };
	private lastContextToken?: string;

	constructor(account: WeixinAccount) {
		this.account = account;
		this.typingInfo = { typing_ticket: undefined, update_time: 0 };
	}

	async start(onMessage: OnMessage, signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			// get messages
			let updatesMessage = null;

			try {
				updatesMessage = await getUpdates({
					baseUrl: this.account.baseurl,
					token: this.account.bot_token,
					timeoutMs: 2000,
				});
			} catch (err) {
				logger.error("[weixin] getUpdates error: %s", (err as Error).message);
				await new Promise((resolve) => setTimeout(resolve, 1000));
				continue;
			}

			if (!updatesMessage) {
				continue;
			}

			// check error
			if (updatesMessage?.errmsg) {
				logger.error("[weixin] getUpdates error: %s", JSON.stringify(updatesMessage));
				await new Promise((resolve) => setTimeout(resolve, 1000));
				continue;
			}

			if (!updatesMessage.msgs || updatesMessage.msgs.length === 0) {
				continue;
			}

			const sessionId = `weixin-${this.account.ilink_user_id}`;
			console.log(
				`[weixin] received message user_id=${this.account.ilink_user_id}, routeId=${DEFAULT_ROUTE_ID}, sessionId=${sessionId}, msgs=${JSON.stringify(updatesMessage)}`,
			);

			const lastMsg = updatesMessage.msgs[updatesMessage.msgs.length - 1];
			if (lastMsg.context_token) {
				this.lastContextToken = lastMsg.context_token;
			}

			const source: MessageSource = {
				channelId: DEFAULT_CHANNEL_ID,
				routeId: DEFAULT_ROUTE_ID,
				sessionId: sessionId,
				metadata: {
					accountId: this.account.ilink_user_id,
				},
			};

			// handler media message
			const mediaItems = await this._handlerMedia(updatesMessage.msgs);
			if (mediaItems.length > 0) {
				onMessage(source, {
					type: "file",
					filePath: mediaItems[0].filePath,
					fileName: mediaItems[0].fileName,
				});
				continue;
			}
			// handler text message
			const msgItems = await this._handlerMessage(updatesMessage.msgs);
			if (msgItems.length > 0) {
				onMessage(source, {
					type: "text",
					text: msgItems[0],
				});
			}
		}
	}

	private async _handlerMedia(msgs: WeixinMessage[]): Promise<{ filePath: string; fileName: string; type: string }[]> {
		const mediaItems: { filePath: string; fileName: string; type: string }[] = [];
		for (const msg of msgs) {
			if (msg.item_list?.length) {
				for (const item of msg.item_list) {
					await downloadMediaFromItem(item, {
						label: `downloadMedia[${this.account.ilink_user_id}]`,
						cdnBaseUrl: DEFAULT_CDN_BASE_URL,
						saveMedia: async (buffer, _contentType, _subdir, _maxBytes, originalFilename) => {
							const fileName = `${originalFilename || randomUUID()}`;
							const filePath = join(tmpdir(), fileName);
							await fs.promises.writeFile(filePath, buffer);
							mediaItems.push({ filePath: filePath, fileName: fileName, type: "file" });
							return { path: filePath };
						},
						log(_msg) {},
						errLog(_msg) {},
					});
				}
			}
		}
		return mediaItems;
	}

	private async _handlerMessage(msgs: WeixinMessage[]): Promise<string[]> {
		const textContents: string[] = [];
		for (const msg of msgs) {
			if (msg.item_list?.length) {
				for (const item of msg.item_list) {
					if (item.type === MessageItemType.TEXT && item.text_item?.text) {
						textContents.push(item.text_item.text);
					}
				}
			}
		}
		return textContents;
	}

	async handleSendEvent(_source: MessageSource, event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start") {
			await this._sendTyping(1);
			return;
		}

		if (event.type === "agent_end") {
			await this._sendTyping(2);
			// Check the last message for error info. We have to wait until the end of the agent run to know if there were any errors,
			const lastMsg = event.messages[event.messages.length - 1];
			if (lastMsg && lastMsg.role === "assistant") {
				if (lastMsg.stopReason === "length" || lastMsg.stopReason === "error" || lastMsg.stopReason === "aborted") {
					const errMsg = `[Error](${lastMsg.stopReason}) ${lastMsg.errorMessage ?? ""}`;
					await this._sendText(errMsg, false);
				} else if (lastMsg.stopReason === "stop") {
					const finalMsg = this._extractText(lastMsg.content);
					if (finalMsg) {
						await this._sendText(finalMsg, true);
					} else {
						await this._sendText(`[No text content to display]`, false);
					}
				}
			} else {
				await this._sendText(`[last message role isn't assistant, it's ${lastMsg.role}]`, false);
			}
			return;
		}

		// Handle sendMedia tool execution: upload and send file/image
		if (event.type === "tool_execution_end" && event.toolName === "sendMedia" && !event.isError) {
			const details = event.result?.details as { path?: string; type?: string } | undefined;
			if (details?.path && details?.type) {
				await this._sendMedia(details.path, details.type);
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

	private async _sendText(content: string, _status: boolean): Promise<void> {
		await sendMessageWeixin({
			to: this.account.ilink_user_id,
			text: content,
			opts: {
				baseUrl: this.account.baseurl,
				token: this.account.bot_token,
				timeoutMs: 1000,
				contextToken: this.lastContextToken,
			},
		});
	}

	/** Upload and send a file or image via sendMedia tool */
	private async _sendMedia(filePath: string, _type: string): Promise<void> {
		await sendWeixinMediaFile({
			filePath,
			to: this.account.ilink_user_id,
			text: "",
			opts: {
				baseUrl: this.account.baseurl,
				token: this.account.bot_token,
				timeoutMs: 1000,
				contextToken: this.lastContextToken,
			},
			cdnBaseUrl: DEFAULT_CDN_BASE_URL, // not needed since sendWeixinMediaFile will use the upload APIs which return full URLs
		});
	}

	/** 1=typing, 2=cancel typing */
	private async _sendTyping(status: 1 | 2): Promise<void> {
		if (
			this.typingInfo == null ||
			this.typingInfo.typing_ticket === undefined ||
			Date.now() - this.typingInfo.update_time > DEFAULT_TYPING_INFO_EXPIRATION_MS
		) {
			const configResult = await getConfig({
				baseUrl: this.account.baseurl,
				token: this.account.bot_token,
				timeoutMs: 1000,
				ilinkUserId: this.account.ilink_user_id,
			});
			if (configResult?.typing_ticket) {
				this.typingInfo = { typing_ticket: configResult.typing_ticket, update_time: Date.now() };
			} else {
				logger.error(
					"[weixin] get typing_ticket failed , cannot send typing indicator. user_id=%s, error=%s",
					this.account.ilink_user_id,
					JSON.stringify(configResult),
				);
				return;
			}
		}

		await sendTyping({
			baseUrl: this.account.baseurl,
			token: this.account.bot_token,
			timeoutMs: 1000,
			body: {
				ilink_user_id: this.account.ilink_user_id,
				typing_ticket: this.typingInfo.typing_ticket,
				status: status,
			},
		});
	}
}
