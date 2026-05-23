import crypto from "node:crypto";
import { logger } from "../../../logger.js";
import { redactBody, redactUrl } from "../util/redact.js";
import type {
	BaseInfo,
	GetConfigResp,
	GetUpdatesReq,
	GetUpdatesResp,
	GetUploadUrlReq,
	GetUploadUrlResp,
	NotifyStartResp,
	NotifyStopResp,
	SendMessageReq,
	SendTypingReq,
} from "./types.js";

export type WeixinApiOptions = {
	baseUrl: string;
	token?: string;
	timeoutMs?: number;
	/** Long-poll timeout for getUpdates (server may hold the request up to this). */
	longPollTimeoutMs?: number;
};

/** Default timeout for long-poll getUpdates requests. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default timeout for regular API requests (sendMessage, getUploadUrl). */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Default timeout for lightweight API requests (getConfig, sendTyping). */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

function ensureTrailingSlash(url: string): string {
	return url.endsWith("/") ? url : `${url}/`;
}

/** Build the `base_info` payload included in every API request. */
export function buildBaseInfo(): BaseInfo {
	return {
		channel_version: "0.0.1",
		bot_agent: "jsmart-weixin",
	};
}

// ---------------------------------------------------------------------------
// Auth / headers
// ---------------------------------------------------------------------------

function randomWechatUin(): string {
	const uint32 = crypto.randomBytes(4).readUInt32BE(0);
	return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildCommonHeaders(token?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		AuthorizationType: "ilink_bot_token",
		"X-WECHAT-UIN": randomWechatUin(),
		"iLink-App-Id": "bot",
		"iLink-App-ClientVersion": "131073",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

/**
 * GET fetch wrapper: send a GET request to a Weixin API endpoint.
 * When `timeoutMs` is set, the request is aborted after that many milliseconds.
 * Query parameters should already be encoded in `endpoint`.
 * Returns the raw response text on success; throws on HTTP error or (if used) timeout abort.
 */
export async function apiGetFetch(params: {
	baseUrl: string;
	endpoint: string;
	timeoutMs?: number;
	label: string;
}): Promise<string> {
	const base = ensureTrailingSlash(params.baseUrl);
	const url = new URL(params.endpoint, base);
	const hdrs = buildCommonHeaders();
	logger.debug(`GET ${redactUrl(url.toString())}`);
	const timeoutMs = params.timeoutMs;
	const controller = timeoutMs != null && timeoutMs > 0 ? new AbortController() : undefined;
	const t = controller != null && timeoutMs != null ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
	try {
		const res = await fetch(url.toString(), {
			method: "GET",
			headers: hdrs,
			...(controller ? { signal: controller.signal } : {}),
		});
		if (t !== undefined) clearTimeout(t);
		const rawText = await res.text();
		logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
		if (!res.ok) {
			throw new Error(`${params.label} ${res.status}: ${rawText}`);
		}
		return rawText;
	} catch (err) {
		if (t !== undefined) clearTimeout(t);
		throw err;
	}
}

/**
 * Common fetch wrapper: POST JSON to a Weixin API endpoint.
 * When `timeoutMs` is provided, the request is aborted after that many milliseconds.
 * When omitted, no client-side timeout is applied (relies on OS/TCP stack).
 * Returns the raw response text on success; throws on HTTP error or timeout.
 */
export async function apiPostFetch(params: {
	baseUrl: string;
	endpoint: string;
	body: string;
	token?: string;
	timeoutMs?: number;
	label: string;
}): Promise<string> {
	const base = ensureTrailingSlash(params.baseUrl);
	const url = new URL(params.endpoint, base);
	const hdrs = buildCommonHeaders(params.token);
	logger.debug(`POST ${redactUrl(url.toString())} body=${redactBody(params.body)}`);
	const controller = params.timeoutMs !== undefined ? new AbortController() : undefined;
	const t =
		controller != null && params.timeoutMs !== undefined
			? setTimeout(() => controller.abort(), params.timeoutMs)
			: undefined;
	try {
		const res = await fetch(url.toString(), {
			method: "POST",
			headers: hdrs,
			body: params.body,
			...(controller ? { signal: controller.signal } : {}),
		});
		if (t !== undefined) clearTimeout(t);
		const rawText = await res.text();
		logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
		if (!res.ok) {
			throw new Error(`${params.label} ${res.status}: ${rawText}`);
		}
		return rawText;
	} catch (err) {
		if (t !== undefined) clearTimeout(t);
		throw err;
	}
}

/**
 * Long-poll getUpdates. Server should hold the request until new messages or timeout.
 *
 * On client-side timeout (no server response within timeoutMs), returns an empty response
 * with ret=0 so the caller can simply retry. This is normal for long-poll.
 */
export async function getUpdates(
	params: GetUpdatesReq & {
		baseUrl: string;
		token?: string;
		timeoutMs?: number;
	},
): Promise<GetUpdatesResp> {
	const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
	try {
		const rawText = await apiPostFetch({
			baseUrl: params.baseUrl,
			endpoint: "ilink/bot/getupdates",
			body: JSON.stringify({
				get_updates_buf: params.get_updates_buf ?? "",
				base_info: buildBaseInfo(),
			}),
			token: params.token,
			timeoutMs: timeout,
			label: "getUpdates",
		});
		const resp: GetUpdatesResp = JSON.parse(rawText);
		return resp;
	} catch (err) {
		// Long-poll timeout is normal; return empty response so caller can retry
		if (err instanceof Error && err.name === "AbortError") {
			logger.debug(`getUpdates: client-side timeout after ${timeout}ms, returning empty response`);
			return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
		}
		throw err;
	}
}

/** Get a pre-signed CDN upload URL for a file. */
export async function getUploadUrl(params: GetUploadUrlReq & WeixinApiOptions): Promise<GetUploadUrlResp> {
	const rawText = await apiPostFetch({
		baseUrl: params.baseUrl,
		endpoint: "ilink/bot/getuploadurl",
		body: JSON.stringify({
			filekey: params.filekey,
			media_type: params.media_type,
			to_user_id: params.to_user_id,
			rawsize: params.rawsize,
			rawfilemd5: params.rawfilemd5,
			filesize: params.filesize,
			thumb_rawsize: params.thumb_rawsize,
			thumb_rawfilemd5: params.thumb_rawfilemd5,
			thumb_filesize: params.thumb_filesize,
			no_need_thumb: params.no_need_thumb,
			aeskey: params.aeskey,
			base_info: buildBaseInfo(),
		}),
		token: params.token,
		timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
		label: "getUploadUrl",
	});
	const resp: GetUploadUrlResp = JSON.parse(rawText);
	return resp;
}

/** Send a single message downstream. */
export async function sendMessage(params: WeixinApiOptions & { body: SendMessageReq }): Promise<void> {
	await apiPostFetch({
		baseUrl: params.baseUrl,
		endpoint: "ilink/bot/sendmessage",
		body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
		token: params.token,
		timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
		label: "sendMessage",
	});
}

/** Fetch bot config (includes typing_ticket) for a given user. */
export async function getConfig(
	params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
	const rawText = await apiPostFetch({
		baseUrl: params.baseUrl,
		endpoint: "ilink/bot/getconfig",
		body: JSON.stringify({
			ilink_user_id: params.ilinkUserId,
			context_token: params.contextToken,
			base_info: buildBaseInfo(),
		}),
		token: params.token,
		timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
		label: "getConfig",
	});
	const resp: GetConfigResp = JSON.parse(rawText);
	return resp;
}

/** Send a typing indicator to a user. */
export async function sendTyping(params: WeixinApiOptions & { body: SendTypingReq }): Promise<void> {
	await apiPostFetch({
		baseUrl: params.baseUrl,
		endpoint: "ilink/bot/sendtyping",
		body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
		token: params.token,
		timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
		label: "sendTyping",
	});
}

/**
 * Notify Weixin that this channel client is stopping (gateway shutdown / channel stop).
 * Uses a standalone timeout (not the gateway abort signal) so the request can finish
 * after OpenClaw has already aborted the long-poll.
 */
export async function notifyStop(params: WeixinApiOptions): Promise<NotifyStopResp> {
	const rawText = await apiPostFetch({
		baseUrl: params.baseUrl,
		endpoint: "ilink/bot/msg/notifystop",
		body: JSON.stringify({ base_info: buildBaseInfo() }),
		token: params.token,
		timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
		label: "notifyStop",
	});
	return JSON.parse(rawText) as NotifyStopResp;
}

/**
 * Notify Weixin that this channel client is starting (gateway startup / channel start).
 */
export async function notifyStart(params: WeixinApiOptions): Promise<NotifyStartResp> {
	const rawText = await apiPostFetch({
		baseUrl: params.baseUrl,
		endpoint: "ilink/bot/msg/notifystart",
		body: JSON.stringify({ base_info: buildBaseInfo() }),
		token: params.token,
		timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
		label: "notifyStart",
	});
	return JSON.parse(rawText) as NotifyStartResp;
}
