import type { AgentSessionEvent } from "@jsmart/jsmart-harness";

export interface ChannelGeneralConfig {
	readonly rootDir: string;
}

/** Identifies the source of a message — populated by the Channel */
export interface MessageSource {
	/** Channel that received the message */
	channelId: string;
	/** Route ID that matched this message */
	routeId: string;
	/** Session ID for this conversation (e.g. chatId for Feishu, config-defined for Console) */
	sessionId: string;
	/** Channel-specific metadata (e.g. Feishu: chatId, messageId, threadId) */
	metadata?: Record<string, unknown>;
}

/** Content types for incoming messages */
export type MessageContent =
	| { type: "text"; text: string }
	| { type: "file"; text?: string; filePath: string; fileName: string };

/** Callback that Channel calls when it receives a message */
export type OnMessage = (source: MessageSource, content: MessageContent) => Promise<void>;

/** Channel interface: communication protocol abstraction */
export interface Channel {
	/** Unique channel identifier */
	readonly id: string;

	/**
	 * Start the channel.
	 * onMessage is called when a message arrives from the external system.
	 * The channel is responsible for determining routeId and sessionId.
	 */
	start(onMessage: OnMessage): Promise<void>;

	/**
	 * Receive a raw AgentSessionEvent.
	 * The channel decides which events to forward to the user (e.g. thinking, tool calls, final text).
	 * Default: no-op for backward compatibility.
	 */
	sendEvent?(source: MessageSource, event: AgentSessionEvent, signal: AbortSignal): Promise<void>;

	/** Stop the channel: disconnect, cleanup resources */
	stop(): Promise<void>;
}
