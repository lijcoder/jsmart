import { randomBytes } from "node:crypto";
import { logger } from "../../logger.js";
import type { BaseInfo, GetConfigResp, GetUpdatesResp } from "./types.js";

// ---------------------------------------------------------------------------
// Auth / headers
// ---------------------------------------------------------------------------

function randomWechatUin(): string {
	const uint32 = randomBytes(4).readUInt32BE(0);
	return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string): Record<string, string> {
	const hdrs: Record<string, string> = {
		"Content-Type": "application/json",
		AuthorizationType: "ilink_bot_token",
		"X-WECHAT-UIN": randomWechatUin(),
		"iLink-App-Id": "bot",
		"iLink-App-ClientVersion": "131073",
	};
	if (token) {
		hdrs.Authorization = `Bearer ${token}`;
	}
	return hdrs;
}

const BASE_INFO: BaseInfo = { channel_version: "2.4.3", bot_agent: "JSmart" };

function baseUrl(endpoint: string, base: string): string {
	const u = base.endsWith("/") ? base : `${base}/`;
	return new URL(endpoint, u).toString();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function apiPost(
	apiBase: string,
	endpoint: string,
	body: Record<string, unknown>,
	token?: string,
	timeoutMs?: number,
): Promise<string> {
	return retryFetch(() => _apiPost(apiBase, endpoint, body, token, timeoutMs), endpoint);
}

async function _apiPost(
	apiBase: string,
	endpoint: string,
	body: Record<string, unknown>,
	token?: string,
	timeoutMs?: number,
): Promise<string> {
	const ctrl = timeoutMs != null ? new AbortController() : undefined;
	const t = ctrl != null ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
	try {
		const res = await fetch(baseUrl(endpoint, apiBase), {
			method: "POST",
			headers: buildHeaders(token),
			body: JSON.stringify({ ...body, base_info: BASE_INFO }),
			...(ctrl ? { signal: ctrl.signal } : {}),
		});
		if (t !== undefined) clearTimeout(t);
		const text = await res.text();
		if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${text}`);
		return text;
	} catch (err) {
		if (t !== undefined) clearTimeout(t);
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

const RETRY_MAX = 2;
const RETRY_BASE_MS = 1000;

async function retryFetch(fn: () => Promise<string>, label: string): Promise<string> {
	let lastErr: unknown;
	for (let i = 0; i <= RETRY_MAX; i++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (i < RETRY_MAX && isTransient(err)) {
				const delay = RETRY_BASE_MS * 2 ** i;
				logger.warn("[weixin:api] %s transient failure, retrying in %dms: %s", label, delay, err);
				await new Promise((r) => setTimeout(r, delay));
			} else {
				throw err;
			}
		}
	}
	throw lastErr;
}

function isTransient(err: unknown): boolean {
	if (err instanceof TypeError && err.message === "fetch failed") return true;
	const code = (err as { cause?: { code?: string } }).cause?.code;
	return code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Long-poll for new messages. Returns empty msgs on timeout. */
export async function getUpdates(
	apiBase: string,
	token: string,
	buf: string,
	timeoutMs: number,
): Promise<GetUpdatesResp> {
	try {
		const raw = await apiPost(
			apiBase,
			"ilink/bot/getupdates",
			{ get_updates_buf: buf },
			token,
			timeoutMs + 5_000, // give extra margin to avoid racing the server
		);
		return JSON.parse(raw) as GetUpdatesResp;
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			return { ret: 0, msgs: [], get_updates_buf: buf };
		}
		throw err;
	}
}

/** Get config (typing_ticket) for a user. */
export async function getConfig(
	apiBase: string,
	token: string,
	ilinkUserId: string,
	contextToken?: string,
): Promise<GetConfigResp> {
	const raw = await apiPost(
		apiBase,
		"ilink/bot/getconfig",
		{ ilink_user_id: ilinkUserId, context_token: contextToken },
		token,
		10_000,
	);
	return JSON.parse(raw) as GetConfigResp;
}

/** Send a text message. Requires the context_token from the inbound message. */
export async function sendMessage(
	apiBase: string,
	token: string,
	to: string,
	text: string,
	contextToken: string,
	clientId: string,
): Promise<void> {
	await apiPost(
		apiBase,
		"ilink/bot/sendmessage",
		{
			msg: {
				to_user_id: to,
				client_id: clientId,
				message_type: 2, // BOT
				message_state: 1, // FINISH
				item_list: [{ type: 1, text_item: { text } }],
				context_token: contextToken,
			},
		},
		token,
		15_000,
	);
}

/** Send typing indicator. status: 1=start, 2=cancel. */
export async function sendTyping(
	apiBase: string,
	token: string,
	ilinkUserId: string,
	typingTicket: string,
	status: number,
): Promise<void> {
	await apiPost(
		apiBase,
		"ilink/bot/sendtyping",
		{ ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status },
		token,
		10_000,
	);
}
