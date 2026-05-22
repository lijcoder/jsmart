import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSessionEvent } from "@jsmart/jsmart-harness";
import { logger } from "../../logger.js";
import type { ChannelFactory } from "../registry.js";
import { registerChannelFactory } from "../registry.js";
import type { Channel, MessageSource, OnMessage } from "../types.js";
import { WeixinAccountSession } from "./poll.js";
import type { WeixinAccount } from "./types.js";

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
	private abortController?: AbortController;
	/** accountId → WeixinAccountSession */
	private sessions = new Map<string, WeixinAccountSession>();

	constructor(options: WeixinChannelOptions) {
		this.options = options;
	}

	// ── Channel lifecycle ────────────────────────────────────────

	async start(onMessage: OnMessage): Promise<void> {
		this.abortController = new AbortController();
		const signal = this.abortController.signal;

		const accounts = this._loadAccounts();
		if (accounts.length === 0) {
			logger.warn("[weixin] No accounts found in %s. Please scan QR code to login first.", this.options.accountsDir);
			return;
		}

		logger.info("[weixin] Starting %d account(s) from %s", accounts.length, this.options.accountsDir);

		for (const account of accounts) {
			const session = new WeixinAccountSession(account);
			this.sessions.set(account.ilink_user_id, session);
			session.start(this.id, onMessage, signal);
		}
	}

	async stop(): Promise<void> {
		this.abortController?.abort();
		this.abortController = undefined;
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

	private _loadAccounts(): WeixinAccount[] {
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
