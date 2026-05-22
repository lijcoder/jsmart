import type { AgentSessionEvent } from "@jsmart/jsmart-harness";
import { logger } from "../../logger.js";
import type { MessageSource, OnMessage } from "../types.js";
import { getConfig, getUpdates, sendMessage, sendTyping } from "./api.js";
import type { WeixinAccount, WeixinMessage } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_EXPIRED_ERRCODE = -14;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const PAUSE_DURATION_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// ActiveSession
// ---------------------------------------------------------------------------

export interface ActiveSession {
	accountId: string;
	fromUserId: string;
	contextToken: string;
}

// ---------------------------------------------------------------------------
// WeixinAccountSession — per-account poll loop + message dispatch + reply
// ---------------------------------------------------------------------------

export class WeixinAccountSession {
	readonly accountId: string;

	private account: WeixinAccount;
	private activeSessions = new Map<string, ActiveSession>();
	private syncBuf = "";
	private longPollTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;

	/** Cached typing ticket, refreshed every 12h */
	private cachedTicket: { ticket: string; expiresAt: number } | undefined;
	private static readonly TYPING_TICKET_TTL_MS = 12 * 60 * 60 * 1000;

	constructor(account: WeixinAccount) {
		this.account = account;
		this.accountId = account.ilink_user_id;
	}

	/** Launch the long-poll loop. Returns immediately. */
	start(channelId: string, onMessage: OnMessage, signal: AbortSignal): void {
		(async () => {
			logger.info("[weixin] poll started: account=%s baseUrl=%s", this.accountId, this.account.baseurl);
			let consecutiveFailures = 0;

			while (!signal.aborted) {
				try {
					const resp = await getUpdates(
						this.account.baseurl,
						this.account.bot_token,
						this.syncBuf,
						this.longPollTimeoutMs,
					);

					const isApiError =
						(resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);

					if (isApiError) {
						const isSessionExpired =
							resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

						if (isSessionExpired) {
							logger.error(
								"[weixin] session expired: account=%s, pausing %d min",
								this.accountId,
								PAUSE_DURATION_MS / 60_000,
							);
							consecutiveFailures = 0;
							await sleepSafe(PAUSE_DURATION_MS, signal);
							continue;
						}

						consecutiveFailures++;
						logger.error(
							"[weixin] getUpdates error: account=%s ret=%s errcode=%s errmsg=%s",
							this.accountId,
							resp.ret,
							resp.errcode,
							resp.errmsg,
						);
						await sleepSafe(consecutiveFailures >= 3 ? 30_000 : 2_000, signal);
						continue;
					}

					consecutiveFailures = 0;

					if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
						this.longPollTimeoutMs = resp.longpolling_timeout_ms;
					}
					if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
						this.syncBuf = resp.get_updates_buf;
					}

					for (const msg of resp.msgs ?? []) {
						this._dispatch(channelId, onMessage, msg);
					}
				} catch (err) {
					if (signal.aborted) break;
					consecutiveFailures++;
					logger.error("[weixin] getUpdates exception: account=%s err=%s", this.accountId, err);
					await sleepSafe(consecutiveFailures >= 3 ? 30_000 : 2_000, signal);
				}
			}

			logger.info("[weixin] poll ended: account=%s", this.accountId);
		})();
	}

	/** Handle agent events — typing indicator + final reply. */
	async handleSendEvent(source: MessageSource, event: AgentSessionEvent): Promise<void> {
		const session = this.activeSessions.get(source.sessionId);
		if (!session) return;

		if (event.type === "agent_start") {
			await this._sendTyping(session, 1);
			return;
		}

		if (event.type === "agent_end") {
			await this._sendTyping(session, 2);
			await this._sendFinalReply(session, event.messages);
		}
	}

	// ── Private ──────────────────────────────────────────────────

	private _dispatch(channelId: string, onMessage: OnMessage, msg: WeixinMessage): void {
		const wechatUserId = msg.from_user_id;
		const contextToken = msg.context_token;
		if (!wechatUserId || !contextToken) {
			logger.warn("[weixin] skipping message without from_user_id or context_token");
			return;
		}
		logger.info(
			"[weixin] original Message received: to_user_id=%s, from_user_id=%s, content=%s",
			msg.to_user_id,
			msg.from_user_id,
			JSON.stringify(msg),
		);
		const text = msg.item_list?.map((item) => item.text_item?.text ?? "").join("") ?? "";
		if (!text.trim()) return;

		const sessionId = wechatUserId;

		this.activeSessions.set(sessionId, {
			accountId: this.accountId,
			fromUserId: wechatUserId,
			contextToken,
		});

		const source: MessageSource = {
			channelId,
			routeId: "weixin-main",
			sessionId,
			metadata: { accountId: this.accountId, wechatUserId, contextToken },
		};

		onMessage(source, { type: "text", text }).catch((err) => {
			logger.error("[weixin] onMessage failed: %s", err);
		});
	}

	private async _sendTyping(session: ActiveSession, status: number): Promise<void> {
		const ticket = await this._getTypingTicket(session);
		if (!ticket) return;

		try {
			await sendTyping(this.account.baseurl, this.account.bot_token, session.fromUserId, ticket, status);
		} catch {
			// Best-effort
		}
	}

	private async _getTypingTicket(session: ActiveSession): Promise<string | undefined> {
		if (this.cachedTicket && Date.now() < this.cachedTicket.expiresAt) {
			return this.cachedTicket.ticket;
		}

		try {
			const config = await getConfig(
				this.account.baseurl,
				this.account.bot_token,
				session.fromUserId,
				session.contextToken,
			);
			if (config.typing_ticket) {
				this.cachedTicket = {
					ticket: config.typing_ticket,
					expiresAt: Date.now() + WeixinAccountSession.TYPING_TICKET_TTL_MS,
				};
				return config.typing_ticket;
			}
		} catch {
			// Best-effort
		}

		return this.cachedTicket?.ticket;
	}

	private async _sendFinalReply(session: ActiveSession, messages: unknown[]): Promise<void> {
		const lastMsg = messages[messages.length - 1] as
			| { role?: string; stopReason?: string; errorMessage?: string; content?: { type: string; text?: string }[] }
			| undefined;

		if (!lastMsg || lastMsg.role !== "assistant") return;

		if (lastMsg.stopReason === "stop") {
			const text = (lastMsg.content ?? [])
				.filter((p) => p.type === "text")
				.map((p) => p.text ?? "")
				.join("");
			if (text.trim()) {
				try {
					await sendMessage(
						this.account.baseurl,
						this.account.bot_token,
						session.fromUserId,
						text,
						session.contextToken,
						`openclaw-${Date.now()}`,
					);
				} catch (err) {
					logger.error("[weixin] sendMessage failed: %s", err);
				}
			}
		} else {
			const errText = `[${lastMsg.stopReason}] ${lastMsg.errorMessage ?? ""}`.trim();
			if (errText) {
				try {
					await sendMessage(
						this.account.baseurl,
						this.account.bot_token,
						session.fromUserId,
						errText,
						session.contextToken,
						`openclaw-err-${Date.now()}`,
					);
				} catch (err) {
					logger.error("[weixin] sendMessage (error) failed: %s", err);
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleepSafe(ms: number, signal: AbortSignal): Promise<void> {
	try {
		await new Promise<void>((res, rej) => {
			const t = setTimeout(res, ms);
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(t);
					rej(new Error("aborted"));
				},
				{ once: true },
			);
		});
	} catch {
		// aborted during shutdown
	}
}
