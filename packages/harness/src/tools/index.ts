import type { AgentTool } from "@jsmart/jsmart-agent-core";
import type { Executor } from "../executor.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export function createTools(executor: Executor): AgentTool<any>[] {
	return [createReadTool(executor), createEditTool(executor), createWriteTool(executor), createBashTool(executor)];
}
