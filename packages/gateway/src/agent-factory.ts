import {
	AgentSession,
	DefaultResourceLoader,
	loadPromptTemplate,
	type ModelManager,
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

	const resourceLoader = new DefaultResourceLoader({
		skillPaths: template.skills,
		noSkills: template.skills === undefined,
	});
	const sessionManager = new SessionManager(true, sessionFile);

	// 从工作目录加载 prompt_template.md，没有则使用内置默认模板
	const promptTemplate = loadPromptTemplate(workspaceDir);

	return new AgentSession(
		workspaceDir,
		new SettingsManager({}),
		sessionManager,
		resourceLoader,
		modelManager,
		template.model.provider,
		template.model.model,
		{
			promptTemplate: promptTemplate ?? undefined,
			additionalTools: createGatewayTools(),
		},
	);
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
