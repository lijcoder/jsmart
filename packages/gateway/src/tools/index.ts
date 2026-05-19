import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { createSendMediaTool } from "./send-media.js";

export function createGatewayTools(): AgentTool<any>[] {
	return [createSendMediaTool()];
}
