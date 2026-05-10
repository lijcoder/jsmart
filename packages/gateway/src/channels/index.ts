export { ConsoleChannel, ConsoleChannelFactory, type ConsoleChannelOptions } from "./console-channel.js";
export { FeishuChannel, FeishuChannelFactory, type FeishuChannelOptions } from "./feishu-channel.js";
export {
	type ChannelFactory,
	ChannelRegistry,
	getGlobalRegistry,
	registerChannelFactory,
	resetGlobalRegistry,
} from "./registry.js";
export type { Channel, MessageSource, OnMessage } from "./types.js";
