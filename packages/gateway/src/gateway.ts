import type { AgentSession, AgentSessionEvent } from "@jsmart/jsmart-harness";
import { ModelManager } from "@jsmart/jsmart-harness";
import { createAgentSession } from "./agent-factory.js";
import { getGlobalRegistry } from "./channels/registry.js";
import type { Channel, MessageSource } from "./channels/types.js";
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
	 * Dynamically import each channel module by type, then create instances from config.
	 * Convention: channel modules are named `{type}-channel.js` under channels/.
	 * Importing the module triggers its self-registration via registerChannelFactory().
	 */
	async registerChannelsFromConfig(settings: Settings): Promise<void> {
		const channelsDir = new URL("channels/", import.meta.url).pathname;

		for (const [channelId, chConfig] of Object.entries(settings.channels)) {
			const type = chConfig.type;

			// Dynamic import triggers the module's self-registration
			try {
				await import(`${channelsDir}${type}-channel.js`);
			} catch {
				logger.error(
					'[Gateway] Channel "%s" skipped: type "%s" has no implementation. Expected "%s-channel.js" in channels/ directory.',
					channelId,
					type,
					type,
				);
				continue;
			}

			const channel = getGlobalRegistry().create(type, chConfig);
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
	private async _handleMessage(source: MessageSource, content: string): Promise<void> {
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
			const unsub = session.subscribe((event) => {
				this._handleSessionEvent(source, event).catch((err) => {
					logger.error("[Gateway] Session event handling failed: %s", err);
				});
			});
			this.unsubscribes.set(sessionKey, unsub);
		}

		// Forward message to the session
		await session.prompt(content);
	}

	/** Handle events from an AgentSession and forward to the channel */
	private async _handleSessionEvent(source: MessageSource, event: AgentSessionEvent): Promise<void> {
		const channel = this.channels.get(source.channelId);
		if (!channel) return;
		await channel.sendEvent?.(source, event);
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
