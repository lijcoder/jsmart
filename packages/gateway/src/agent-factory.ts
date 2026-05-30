import {
	AgentSession,
	createBashTool,
	createEditTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	loadPromptTemplate,
	type ModelManager,
	NodeFsProvider,
	NodeShellProvider,
	SessionManager,
	SettingsManager,
} from "@jsmart/jsmart-harness";
import { existsSync, mkdirSync } from "fs";
import type { Settings } from "./config.js";
import { resolveAgentSessionsDir, resolveAgentWorkspaceDir, resolveSessionFile } from "./config.js";
import { createGatewayTools } from "./tools/index.js";

/**
 * Create an AgentSession from a route.
 * @param routeId - The route ID to look up the agent template
 * @param sessionId - The session identifier
 * @param agentName - The agent template name
 * @param rootDir - Root directory for resolving paths
 * @param modelManager - Shared ModelManager instance (global, not per-session)
 */
export function createAgentSession(
	routeId: string,
	sessionId: string,
	agentName: string,
	rootDir: string,
	modelManager: ModelManager,
	config: Settings,
): AgentSession {
	// Find the route across all channels
	const route = _findRoute(routeId, config);
	if (!route) {
		throw new Error(`Route "${routeId}" not found in config`);
	}

	const template = config.agentTemplates[route.agent];
	if (!template) {
		throw new Error(
			`Agent template "${route.agent}" not found. Available: ${Object.keys(config.agentTemplates).join(", ")}`,
		);
	}

	// Resolve directories
	const workspaceDir = resolveAgentWorkspaceDir(rootDir, agentName);
	const sessionsDir = resolveAgentSessionsDir(rootDir, agentName);
	const sessionFile = resolveSessionFile(rootDir, agentName, sessionId);

	// Ensure sessions directory exists
	if (!existsSync(sessionsDir)) {
		mkdirSync(sessionsDir, { recursive: true });
	}

	const sessionManager = new SessionManager(true, sessionFile);

	// 从工作目录加载 prompt_template.md，没有则使用内置默认模板
	const promptTemplate = loadPromptTemplate(workspaceDir);

	// 合并：template 级别覆盖全局，skillPaths 追加合并
	const globalAgentSettings = config.agentSettings ?? {};
	const templateAgentSettings = template.agentSettings ?? {};
	const mergedAgentSettings = {
		...globalAgentSettings,
		...templateAgentSettings,
		skillPaths: [...(globalAgentSettings.skillPaths ?? []), ...(templateAgentSettings.skillPaths ?? [])],
	};

	const fsProvider = new NodeFsProvider({ cwd: workspaceDir });
	const shellProvider = new NodeShellProvider({ cwd: workspaceDir });
	const tools = [
		createBashTool(shellProvider),
		createReadTool(fsProvider),
		createWriteTool(fsProvider),
		createEditTool(fsProvider),
		createLsTool(fsProvider),
		createGrepTool(fsProvider),
		...createGatewayTools(),
	];

	const session = new AgentSession(
		workspaceDir,
		new SettingsManager(mergedAgentSettings),
		sessionManager,
		modelManager,
		{
			promptTemplate: promptTemplate ?? undefined,
			tools,
		},
	);
	return session;
}

/** Find a route by ID across all channels */
function _findRoute(routeId: string, config: Settings) {
	for (const ch of Object.values(config.channels)) {
		for (const route of ch.routes) {
			if (route.id === routeId) return route;
		}
	}
	return undefined;
}
