import type { AgentSession, AgentSessionEvent } from "@jsmart/jsmart-harness";
import { ModelManager } from "@jsmart/jsmart-harness";
import { existsSync, mkdirSync, renameSync } from "fs";
import { resolve } from "path";
import { createAgentSession } from "./agent-factory.js";
import { getGlobalRegistry } from "./channels/registry.js";
import type { Channel, ChannelGeneralConfig, MessageContent, MessageSource } from "./channels/types.js";
import type { Settings } from "./config.js";
import { logger } from "./logger.js";

export class Gateway {
	private settings: Settings;
	private rootDir: string;
	private modelManager: ModelManager;
	private channels = new Map<string, Channel>();
	/** "agentName:sessionId" → AgentSession cache */
	private sessions = new Map<string, AgentSession>();
	/** "agentName:sessionId" → unsubscribe function */
	private unsubscribes = new Map<string, () => void>();

	constructor(settings: Settings, rootDir: string, modelFile: string) {
		this.settings = settings;
		this.rootDir = rootDir;
		this.modelManager = new ModelManager(modelFile);
	}

	/** Register a channel */
	registerChannel(channel: Channel): void {
		this.channels.set(channel.id, channel);
		logger.info("[Gateway] Channel registered: %s", channel.id);
	}

	/**
	 * Load channel implementations by scanning extension directories.
	 *
	 * Each channel `type` is loaded from `{dir}/{type}/channel.js`.
	 * The built-in `channels/` directory is always searched first (as default),
	 * followed by any additional directories in `settings.channelDirs`.
	 *
	 * Importing the module triggers its self-registration via registerChannelFactory().
	 */
	async registerChannelsFromConfig(settings: Settings): Promise<void> {
		// Built-in channels directory is always the first search path
		const builtinDir = new URL("channels/", import.meta.url).pathname;
		const extraDirs = (settings.channelDirs ?? []).map((d) => resolve(this.rootDir, d));
		const searchDirs = [builtinDir, ...extraDirs];

		for (const [channelId, chConfig] of Object.entries(settings.channels)) {
			const type = chConfig.type;
			let loaded = false;

			for (const dir of searchDirs) {
				// Try .js first (production), then .ts (development / tsx)
				for (const ext of [".js", ".ts"]) {
					const entry = resolve(dir, type, `channel${ext}`);
					if (!existsSync(entry)) continue;
					try {
						await import(entry);
						loaded = true;
						logger.info('[Gateway] Channel "%s" loaded from: %s', channelId, entry);
						break;
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						logger.error('[Gateway] Channel "%s" failed to load from "%s": %s', channelId, entry, msg);
					}
				}
				if (loaded) break;
			}

			if (!loaded) {
				logger.error(
					'[Gateway] Channel "%s" skipped: type "%s" not found in any search dir [%s]',
					channelId,
					type,
					searchDirs.join(", "),
				);
				continue;
			}
			const generalConfig: ChannelGeneralConfig = {
				rootDir: this.rootDir,
			};
			const channel = getGlobalRegistry().create(type, chConfig, generalConfig);
			this.registerChannel(channel);
		}
	}

	/** Start all registered channels */
	async start(): Promise<void> {
		for (const channel of this.channels.values()) {
			await channel.start((source, content) => this._handleMessage(source, content));
		}
	}

	/** Stop all channels and sessions */
	async stop(): Promise<void> {
		for (const unsub of this.unsubscribes.values()) {
			unsub();
		}
		this.unsubscribes.clear();
		this.sessions.clear();

		for (const channel of this.channels.values()) {
			await channel.stop();
		}
	}

	/** Handle an incoming message from a channel */
	private async _handleMessage(source: MessageSource, content: MessageContent): Promise<void> {
		// Find the route to determine which agent to use
		const route = _findRoute(source.routeId, this.settings);
		if (!route) {
			logger.warn('[Gateway] Route "%s" not found, dropping message.', source.routeId);
			return;
		}

		const sessionKey = `${route.agent}:${source.sessionId}`;

		// Get or create AgentSession for this agent+sessionId
		let session = this.sessions.get(sessionKey);
		if (!session) {
			session = createAgentSession(
				source.routeId,
				source.sessionId,
				route.agent,
				this.rootDir,
				this.modelManager,
				this.settings,
			);
			this.sessions.set(sessionKey, session);

			// Subscribe to session events for response routing
			const unsub = session.subscribe((event, signal) => {
				this._handleSessionEvent(source, event, signal).catch((err) => {
					logger.error("[Gateway] Session event handling failed: %s", err);
				});
			});
			this.unsubscribes.set(sessionKey, unsub);
		}

		// Format content into prompt text for the agent
		const promptText = this._formatMessageContent(content, session.getWorkspace());
		await session.prompt(promptText);
	}

	/** Format a MessageContent object into prompt text for the agent */
	private _formatMessageContent(content: MessageContent, workspaceDir: string): string {
		switch (content.type) {
			case "text":
				return content.text;
			case "file": {
				const result = this._moveToWorkspace(content.filePath, content.fileName, workspaceDir);
				if (!result.success) {
					return `[FILE] User uploaded file ${content.fileName}. Failed to move to workspace: ${result.error}. Do not take action, wait for user instructions.`;
				}
				return `[FILE] User uploaded file ${content.fileName} and saved it to [${result.filePath}]. Do not take action, wait for user instructions.`;
			}
		}
	}

	/** Move a file into the workspace directory. Returns the new path or the original temp path on failure. */
	private _moveToWorkspace(
		tempPath: string,
		fileName: string,
		workspaceDir: string,
	): { success: boolean; filePath: string; error?: string } {
		if (!existsSync(workspaceDir)) {
			mkdirSync(workspaceDir, { recursive: true });
		}
		const destPath = `${workspaceDir}/${fileName}`;
		try {
			renameSync(tempPath, destPath);
			logger.info("[Gateway] Moved file to workspace: %s -> %s", tempPath, destPath);
			return { success: true, filePath: destPath };
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			logger.error("[Gateway] Failed to move file to workspace: %s", errMsg);
			return { success: false, filePath: tempPath, error: errMsg };
		}
	}

	/** Handle events from an AgentSession and forward to the channel */
	private async _handleSessionEvent(
		source: MessageSource,
		event: AgentSessionEvent,
		signal: AbortSignal,
	): Promise<void> {
		const channel = this.channels.get(source.channelId);
		if (!channel) return;
		await channel.sendEvent?.(source, event, signal);
	}
}

/** Find a route by ID across all channels */
function _findRoute(routeId: string, settings: Settings) {
	for (const ch of Object.values(settings.channels)) {
		for (const route of ch.routes) {
			if (route.id === routeId) return route;
		}
	}
	return undefined;
}
