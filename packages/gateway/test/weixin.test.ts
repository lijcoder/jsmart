/**
 * Minimal weixin chat integration test with QR code login.
 *
 * The weixin channel uses:
 *   - QR code login (get_bot_qrcode + get_qrcode_status) to obtain token
 *   - HTTP long-poll (getUpdates) to receive messages
 *   - HTTP POST (sendMessage) to reply
 *
 * Usage:
 *   npx tsx --test test/weixin.test.ts
 *
 * Then scan the QR code from WeChat. After login, send a message to the bot
 * and the test will poll for it, print it, and reply automatically.
 */
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import fs from "fs";

// ---------------------------------------------------------------------------
// Protocol types (mirrors @tencent-weixin/openclaw-weixin)
// ---------------------------------------------------------------------------

const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
const MessageType = { USER: 1, BOT: 2 } as const;
const MessageState = { FINISH: 1 } as const;

interface BaseInfo {
	channel_version?: string;
	bot_agent?: string;
}

interface TextItem {
	text?: string;
}

interface MessageItem {
	type?: number;
	text_item?: TextItem;
}

interface WeixinMessage {
	from_user_id?: string;
	to_user_id?: string;
	client_id?: string;
	session_id?: string;
	message_type?: number;
	message_state?: number;
	item_list?: MessageItem[];
	context_token?: string;
}

interface GetUpdatesResp {
	ret?: number;
	msgs?: WeixinMessage[];
	get_updates_buf?: string;
}

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

function buildBaseInfo(): BaseInfo {
	return { channel_version: "2.4.3", bot_agent: "OpenClaw" };
}

function ensureTrailingSlash(url: string): string {
	return url.endsWith("/") ? url : `${url}/`;
}

// ---------------------------------------------------------------------------
// Low-level HTTP
// ---------------------------------------------------------------------------

async function apiPost(
	baseUrl: string,
	endpoint: string,
	body: Record<string, unknown>,
	token?: string,
	timeoutMs?: number,
): Promise<string> {
	const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
	const ctrl = timeoutMs != null ? new AbortController() : undefined;
	const t = ctrl != null ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
	try {
		const res = await fetch(url.toString(), {
			method: "POST",
			headers: buildHeaders(token),
			body: JSON.stringify({ ...body, base_info: buildBaseInfo() }),
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

async function apiGet(baseUrl: string, endpoint: string, timeoutMs?: number): Promise<string> {
	const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
	const ctrl = timeoutMs != null ? new AbortController() : undefined;
	const t = ctrl != null ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
	try {
		const res = await fetch(url.toString(), {
			method: "GET",
			headers: {
				"iLink-App-Id": "bot",
				"iLink-App-ClientVersion": "131073",
			},
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
// QR login
// ---------------------------------------------------------------------------

const BASE_URL = "https://ilinkai.weixin.qq.com";

interface QRCodeResp {
	ret: number;
	qrcode: string;
	qrcode_img_content: string;
}

interface QRStatusResp {
	baseurl: string;
	status: string;
	ret: number;
	ilink_bot_id: string;
	bot_token: string;
	ilink_user_id: string;
}

async function fetchQRCode(): Promise<QRCodeResp> {
	const uri = "ilink/bot/get_bot_qrcode?bot_type=3";
	const raw = await apiPost(BASE_URL, uri, {});
	console.log("[weixin] get_bot_qrcode response: %s", raw);
	return JSON.parse(raw) as QRCodeResp;
}

async function pollQRStatus(qrcode: string): Promise<QRStatusResp> {
	const uri = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
	const raw = await apiGet(BASE_URL, uri, 35_000);
	return JSON.parse(raw) as QRStatusResp;
}

// ---------------------------------------------------------------------------
// Message API
// ---------------------------------------------------------------------------

interface GetConfigReq {
	ilink_user_id: string;
	context_token?: string;
}

interface GetConfigResp {
	ret?: number;
	errcode?: number;
	errmsg?: string;
	typing_ticket?: string;
}

interface SendTypingReq {
	ilink_user_id: string;
	typing_ticket: string;
	/** 1=显示"正在输入...", 2=取消 */
	status: number;
}

async function doGetConfig(baseUrl: string, token: string, req: GetConfigReq): Promise<GetConfigResp> {
	const raw = await apiPost(
		baseUrl,
		"ilink/bot/getconfig",
		{
			ilink_user_id: req.ilink_user_id,
			context_token: req.context_token,
		},
		token,
	);
	return JSON.parse(raw) as GetConfigResp;
}

async function doSendTyping(baseUrl: string, token: string, req: SendTypingReq): Promise<void> {
	await apiPost(
		baseUrl,
		"ilink/bot/sendtyping",
		{
			ilink_user_id: req.ilink_user_id,
			typing_ticket: req.typing_ticket,
			status: req.status,
		},
		token,
	);
}

async function doGetUpdates(baseUrl: string, token: string, buf: string, timeoutMs = 30_000): Promise<GetUpdatesResp> {
	try {
		const raw = await apiPost(baseUrl, "ilink/bot/getupdates", { get_updates_buf: buf }, token, timeoutMs);
		return JSON.parse(raw) as GetUpdatesResp;
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			return { ret: 0, msgs: [], get_updates_buf: buf };
		}
		throw err;
	}
}

async function doSendMessage(
	baseUrl: string,
	token: string,
	to: string,
	text: string,
	contextToken: string,
): Promise<void> {
	await apiPost(
		baseUrl,
		"ilink/bot/sendmessage",
		{
			msg: {
				to_user_id: to,
				client_id: `test-${Date.now()}`,
				message_type: MessageType.BOT,
				message_state: MessageState.FINISH,
				item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
				context_token: contextToken,
			},
		},
		token,
	);
}

const weicaht_bot_dir = "/Users/lijie/.jsmart-debug/weixin/accounts";
// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
test("storeQrCode", { timeout: 60_000 }, async () => {
	const qrResp = await fetchQRCode();
	console.log("\n[weixin] Open this link and scan with WeChat:\n  %s\n", qrResp.qrcode_img_content);
	console.log("[weixin] Waiting for WeChat scan (8 min timeout)...");

	const deadline = Date.now() + 480_000;
	let scannedPrinted = false;
	const qrcode = qrResp.qrcode;

	while (Date.now() < deadline) {
		const statusResp = await pollQRStatus(qrcode);
		switch (statusResp.status) {
			case "wait":
				break;
			case "scaned":
				if (!scannedPrinted) {
					console.log("[weixin] QR code scanned, confirming...");
					scannedPrinted = true;
				}
				break;
			case "expired": {
				console.log("[weixin] QR code expired.");
				return;
			}
			case "confirmed": {
				// 将statusResp 保存到文件，文件名是 statusResp.ilink_bot_id.json，保存在 weicaht_bot_dir 目录下
				if (!statusResp.ilink_user_id || !statusResp.ilink_bot_id || !statusResp.bot_token) {
					console.log("[weixin] Login confirmed but missing required information!");
					return;
				}
				const userId = statusResp.ilink_user_id;
				const filePath = `${weicaht_bot_dir}/${userId}_token.json`;
				const content = JSON.stringify(statusResp, null, 2);
				await fs.promises.writeFile(filePath, content, "utf-8");
				console.log("[weixin] Status saved to: %s", filePath);
				return;
			}
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
});

test("pullMessage", { timeout: 600_000 }, async () => {
	const files = await fs.promises.readdir(weicaht_bot_dir);
	const tokenFiles = files.filter((f) => f.endsWith("_token.json"));
	if (tokenFiles.length === 0) {
		console.log("[weixin] No token files found in %s. Please run the QR code test first.", weicaht_bot_dir);
		return;
	}

	const filePath = `${weicaht_bot_dir}/${tokenFiles[0]}`;
	const content = await fs.promises.readFile(filePath, "utf-8");
	const statusResp = JSON.parse(content) as QRStatusResp;
	console.log("[weixin] Loaded token for user %s from %s", statusResp.ilink_user_id, filePath);

	while (true) {
		try {
			const updates = await doGetUpdates(statusResp.baseurl, statusResp.bot_token, "");
			if (updates.msgs && updates.msgs.length > 0) {
				for (const msg of updates.msgs) {
					console.log("[weixin] Received message from %s: %s", msg.from_user_id, JSON.stringify(msg));
					if (!msg.from_user_id || !msg.context_token) continue;

					// Step 1: getConfig → typing_ticket
					console.log("[weixin] Calling getConfig for user=%s ...", msg.from_user_id);
					const configResp = await doGetConfig(statusResp.baseurl, statusResp.bot_token, {
						ilink_user_id: msg.from_user_id,
						context_token: msg.context_token,
					});
					console.log("[weixin] getConfig response: %s", JSON.stringify(configResp));
					const typingTicket = configResp.typing_ticket ?? "";

					// Step 2: sendTyping(status=1) → 显示"正在输入..."
					if (typingTicket) {
						console.log("[weixin] sendTyping status=1 (typing_ticket=%s...)", typingTicket.slice(0, 20));
						await doSendTyping(statusResp.baseurl, statusResp.bot_token, {
							ilink_user_id: msg.from_user_id,
							typing_ticket: typingTicket,
							status: 1,
						});
						// 模拟处理耗时
						await new Promise((r) => setTimeout(r, 10000));

						// Step 3: sendTyping(status=2) → 取消
						console.log("[weixin] sendTyping status=2");
						await doSendTyping(statusResp.baseurl, statusResp.bot_token, {
							ilink_user_id: msg.from_user_id,
							typing_ticket: typingTicket,
							status: 2,
						});
					} else {
						console.log("[weixin] No typing_ticket, skipping sendTyping.");
					}

					// Step 4: sendMessage
					await doSendMessage(
						statusResp.baseurl,
						statusResp.bot_token,
						msg.from_user_id,
						"Hello from test!",
						msg.context_token,
					);
					console.log("[weixin] Sent reply to %s", msg.from_user_id);
				}
			}
		} catch (err) {
			console.error("[weixin] Error in getUpdates: %s", err instanceof Error ? err.message : String(err));
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
});
