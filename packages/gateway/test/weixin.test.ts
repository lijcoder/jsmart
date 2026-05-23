import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionEvent } from "@jsmart/jsmart-harness";
import { WeixinAccountSession } from "../src/channels/weixin/account-session.js";
import { getUpdates } from "../src/channels/weixin/api/api.js";
import { MessageItemType } from "../src/channels/weixin/api/types.js";
import { fetchQRCode, pollQRStatus } from "../src/channels/weixin/auth/login-qr.js";
import { uploadFileToWeixin } from "../src/channels/weixin/cdn/upload.js";
import { downloadMediaFromItem } from "../src/channels/weixin/media/media-download.js";
import { sendMessageWeixin } from "../src/channels/weixin/messaging/send.js";
import { sendWeixinMediaFile } from "../src/channels/weixin/messaging/send-media.js";

const account = {
	cdnBaseUrl: process.env.WEIXIN_CDN_BASE_URL ?? "",
	baseUrl: process.env.WEIXIN_BASE_URL ?? "",
	ilink_bot_id: process.env.WEIXIN_ILINK_BOT_ID ?? "",
	ilink_user_id: process.env.WEIXIN_ILINK_USER_ID ?? "",
	token: process.env.WEIXIN_BOT_TOKEN ?? "",
};

test("sendMessageWeixin", async () => {
	const result = await sendMessageWeixin({
		to: account.ilink_user_id,
		text: "Hello from test!",
		opts: {
			baseUrl: account.baseUrl,
			token: account.token,
			timeoutMs: 10000,
		},
	});
	console.log("sendMessageWeixin result:", JSON.stringify(result, null, 2));
});

test("getUpdates", async () => {
	// 循环3分钟，每10秒调用一次getUpdates，打印结果
	const start = Date.now();
	console.log("Starting getUpdates loop, will run for 3 minutes...");
	while (Date.now() - start < 3 * 60 * 1000) {
		const result = await getUpdates({
			baseUrl: account.baseUrl,
			token: account.token,
			timeoutMs: 10000,
		});
		console.log("getUpdates result:", JSON.stringify(result, null, 2));
		if (result?.msgs?.length !== undefined && result.msgs.length > 0) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
});

test("getUpdatesFile", { timeout: 60000 }, async () => {
	const start = Date.now();
	console.log("Starting getUpdates loop, will run for 3 minutes...");
	while (Date.now() - start < 3 * 60 * 1000) {
		const result = await getUpdates({
			baseUrl: account.baseUrl,
			token: account.token,
			timeoutMs: 10000,
		});
		console.log("getUpdates result:", JSON.stringify(result, null, 2));

		if (!result.msgs?.length) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			continue;
		}

		// 遍历所有消息和 item_list，跳过纯文本条目
		for (const msg of result.msgs) {
			if (!msg.item_list?.length) continue;
			for (const item of msg.item_list) {
				if (item.type === MessageItemType.TEXT) continue;
				console.log("Processing item type:", item.type);
				const fileResult = await downloadMediaFromItem(item, {
					cdnBaseUrl: account.cdnBaseUrl,
					saveMedia: async (buffer, _contentType, _subdir, _maxBytes, originalFilename) => {
						const filePath = join(tmpdir(), `${originalFilename || randomUUID()}`);
						await fs.promises.writeFile(filePath, buffer);
						console.log("saveMedia called with buffer length:", buffer.length);
						return { path: filePath };
					},
					log: (msg) => console.log("downloadMediaFromItem log:", msg),
					errLog: (msg) => console.error("downloadMediaFromItem error:", msg),
					label: "testDownload",
				});
				console.log("getUpdates file result:", JSON.stringify(fileResult, null, 2));
			}
		}
		// 处理完一批消息后退出
		break;
	}
});

test("uploadFile", async () => {
	const uploadResult = await uploadFileToWeixin({
		filePath: "/Users/lijie/Downloads/test.png",
		toUserId: account.ilink_user_id,
		opts: {
			baseUrl: account.baseUrl,
			token: account.token,
			timeoutMs: 10000,
		},
		cdnBaseUrl: account.cdnBaseUrl,
	});
	console.log("uploadFile result:", JSON.stringify(uploadResult, null, 2));
});

test("sendWeixinMediaFile", async () => {
	const sendResult = await sendWeixinMediaFile({
		filePath: "/Users/lijie/Downloads/test.png",
		to: account.ilink_user_id,
		text: "",
		opts: {
			baseUrl: account.baseUrl,
			token: account.token,
			timeoutMs: 10000,
		},
		cdnBaseUrl: account.cdnBaseUrl,
	});
	console.log("sendWeixinMediaFile result:", JSON.stringify(sendResult, null, 2));
});

test("weixinAccountSessionGetMessage", { timeout: 60000 }, async () => {
	const session = new WeixinAccountSession(
		{
			baseurl: account.baseUrl,
			bot_token: account.token,
			ilink_bot_id: account.ilink_bot_id,
			ilink_user_id: account.ilink_user_id,
		},
		(_account) => {
			return { success: true };
		},
	);
	session.start(async (source, message) => {
		console.log("WeixinAccountSession onMessage source:", JSON.stringify(source, null, 2));
		console.log("WeixinAccountSession onMessage message:", JSON.stringify(message, null, 2));
	}, new AbortController().signal);
});

test("weixinAccountSessionSendMessage", async () => {
	const session = new WeixinAccountSession(
		{
			baseurl: account.baseUrl,
			bot_token: account.token,
			ilink_bot_id: account.ilink_bot_id,
			ilink_user_id: account.ilink_user_id,
		},
		(_account) => {
			return { success: true };
		},
	);
	const source = {
		channelId: "weixin",
		routeId: "weixin-main",
		sessionId: `weixin-${account.ilink_user_id}`,
	};
	const content: AgentSessionEvent = {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "Hello from agent_end event!",
					},
				],
				api: "",
				provider: "",
				model: "",
				usage: {
					input: 0,
					output: 0,
					totalTokens: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: {
						input: 0,
						output: 0,
						total: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		],
	};
	await session.handleSendEvent(source, content);
});

test("weixinAccountSessionSendFile", { timeout: 60000 }, async () => {
	const session = new WeixinAccountSession(
		{
			baseurl: account.baseUrl,
			bot_token: account.token,
			ilink_bot_id: account.ilink_bot_id,
			ilink_user_id: account.ilink_user_id,
		},
		(_account) => {
			return { success: true };
		},
	);
	const source = {
		channelId: "weixin",
		routeId: "weixin-main",
		sessionId: `weixin-${account.ilink_user_id}`,
	};
	const image: AgentSessionEvent = {
		type: "tool_execution_end",
		isError: false,
		toolCallId: "tool-call-id-test",
		toolName: "sendMedia",
		result: {
			details: {
				path: "/Users/lijie/Downloads/test.png",
				type: "image",
			},
		},
	};
	const docx: AgentSessionEvent = {
		type: "tool_execution_end",
		isError: false,
		toolCallId: "tool-call-id-test",
		toolName: "sendMedia",
		result: {
			details: {
				path: "/Users/lijie/Downloads/软件开发工程师-美团.docx",
				type: "file",
			},
		},
	};
	await session.handleSendEvent(source, image);
	await session.handleSendEvent(source, docx);
});

test("getQrCode", async () => {
	const qrcode = await fetchQRCode();
	console.log("fetchQRCode result:", JSON.stringify(qrcode, null, 2));
});

test("pollQrCodeStatus", { timeout: 60000 }, async () => {
	const status = await pollQRStatus("cae9bc340a53a2b2352053a680202b50");
	console.log("pollQRStatus result:", JSON.stringify(status, null, 2));
});
