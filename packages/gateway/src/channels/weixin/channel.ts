import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSessionEvent } from "@jsmart/jsmart-harness";
import { logger } from "../../logger.js";
import type { ChannelFactory } from "../registry.js";
import { registerChannelFactory } from "../registry.js";
import type { Channel, MessageSource, OnMessage } from "../types.js";
import { type WeixinAccount, WeixinAccountSession } from "./account-session.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WeixinChannelOptions {
	/** Directory where account token files ({userId}_token.json) are stored */
	accountsDir: string;
}

// ---------------------------------------------------------------------------
// WeixinChannel
// ---------------------------------------------------------------------------

export class WeixinChannel implements Channel {
	readonly id = "weixin";

	private options: WeixinChannelOptions;
	private abortController: AbortController;
	/** accountId → WeixinAccountSession */
	private sessions = new Map<string, WeixinAccountSession>();

	constructor(options: WeixinChannelOptions) {
		this.options = options;
		this.abortController = new AbortController();
	}

	// ── Channel lifecycle ────────────────────────────────────────

	async start(onMessage: OnMessage): Promise<void> {
		logger.info("[weixin] Channel started");
		const signal = this.abortController.signal;
		this._loadAccounts(signal, onMessage);
	}

	async stop(): Promise<void> {
		this.abortController.abort();
		this.abortController = new AbortController();
		this.sessions.clear();
		logger.info("[weixin] Channel stopped");
	}

	async sendEvent(source: MessageSource, event: AgentSessionEvent): Promise<void> {
		const accountId = source.metadata?.accountId as string | undefined;
		if (!accountId) {
			logger.warn("[weixin] sendEvent: no accountId in metadata, sessionId=%s", source.sessionId);
			return;
		}

		const session = this.sessions.get(accountId);
		if (!session) {
			logger.warn("[weixin] sendEvent: no session for accountId=%s, sessionId=%s", accountId, source.sessionId);
			return;
		}

		await session.handleSendEvent(source, event);
	}

	// ── Account loading ──────────────────────────────────────────

	private async _loadAccounts(signal: AbortSignal, onMessage: OnMessage): Promise<void> {
		while (!signal.aborted) {
			const accounts = this._loadAccountFile();
			if (accounts.length === 0) {
				logger.warn(
					"[weixin] No accounts found in %s. Please scan QR code to login first.",
					this.options.accountsDir,
				);
				continue;
			}

			for (const account of accounts) {
				if (this.sessions.has(account.ilink_user_id)) continue;
				const session = new WeixinAccountSession(account);
				this.sessions.set(account.ilink_user_id, session);
				session.start(onMessage, signal);
			}

			// sleep 10 seconds before next scan
			await new Promise((resolve) => setTimeout(resolve, 60000));
		}
	}

	private _loadAccountFile(): WeixinAccount[] {
		const dir = this.options.accountsDir;
		if (!existsSync(dir)) {
			logger.info("[weixin] Accounts directory does not exist: %s", dir);
			return [];
		}

		const accounts: WeixinAccount[] = [];
		for (const name of readdirSync(dir)) {
			if (!name.endsWith("_token.json")) continue;
			try {
				const raw = readFileSync(resolve(dir, name), "utf-8");
				const parsed = JSON.parse(raw) as WeixinAccount;
				if (parsed.bot_token && parsed.baseurl) {
					accounts.push(parsed);
				}
			} catch {
				logger.warn("[weixin] Failed to parse account file: %s", name);
			}
		}

		return accounts;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const WeixinChannelFactory: ChannelFactory<WeixinChannelOptions> = {
	type: "weixin",
	create: (config) => new WeixinChannel(config),
};

registerChannelFactory(WeixinChannelFactory);
