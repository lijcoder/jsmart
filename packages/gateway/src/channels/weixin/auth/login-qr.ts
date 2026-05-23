import { logger } from "../../../logger.js";
import { apiGetFetch, apiPostFetch } from "../api/api.js";

/** Fixed API base URL for all QR code requests. */
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
/** Default `bot_type` for ilink get_bot_qrcode / get_qrcode_status (this channel build). */
export const DEFAULT_ILINK_BOT_TYPE = "3";
/** Client-side timeout for the long-poll get_qrcode_status request. */
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

export interface QRCodeResponse {
	qrcode: string;
	qrcode_img_content: string;
}

export interface QRCodeStatusResponse {
	status:
		| "wait"
		| "scaned"
		| "confirmed"
		| "expired"
		| "scaned_but_redirect"
		| "need_verifycode"
		| "verify_code_blocked"
		| "binded_redirect";
	bot_token?: string;
	ilink_bot_id?: string;
	baseurl?: string;
	/** The user ID of the person who scanned the QR code. */
	ilink_user_id?: string;
	/** New host to redirect polling to when status is scaned_but_redirect. */
	redirect_host?: string;
}

export async function fetchQRCode(apiBaseUrl?: string, botType?: string): Promise<QRCodeResponse> {
	logger.info(`NewFetching QR code from: ${apiBaseUrl} bot_type=${botType}`);
	//   const localTokenList = getLocalBotTokenList();
	//   logger.info(`newfetchQRCode: local_token_list count=${localTokenList.length}`);
	const doApiBaseUrl = apiBaseUrl || FIXED_BASE_URL;
	const doBotType = botType || DEFAULT_ILINK_BOT_TYPE;
	const rawText = await apiPostFetch({
		baseUrl: doApiBaseUrl,
		endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(doBotType)}`,
		body: JSON.stringify({ local_token_list: [] }),
		label: "fetchQRCode",
	});
	return JSON.parse(rawText) as QRCodeResponse;
}

export async function pollQRStatus(
	qrcode: string,
	apiBaseUrl?: string,
	verifyCode?: string,
): Promise<QRCodeStatusResponse> {
	logger.debug(`Long-poll QR status from: ${apiBaseUrl} qrcode=***`);
	try {
		const doApiBaseUrl = apiBaseUrl || FIXED_BASE_URL;
		let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
		if (verifyCode) {
			endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
		}
		const rawText = await apiGetFetch({
			baseUrl: doApiBaseUrl,
			endpoint,
			timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
			label: "pollQRStatus",
		});
		logger.debug(`pollQRStatus: body=${rawText.substring(0, 200)}`);
		return JSON.parse(rawText) as QRCodeStatusResponse;
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			logger.debug(`pollQRStatus: client-side timeout after ${QR_LONG_POLL_TIMEOUT_MS}ms, returning wait`);
			return { status: "wait" };
		}
		// 网关超时（如 Cloudflare 524）或其他网络错误，视为等待状态继续轮询
		logger.warn(`pollQRStatus: network/gateway error, will retry: ${String(err)}`);
		return { status: "wait" };
	}
}
