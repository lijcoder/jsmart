import { AgentSession, DefaultResourceLoader, ModelManager, SessionManager } from "@jsmart/jsmart-harness";
import { existsSync, mkdirSync } from "fs";
import type { Settings } from "./config.js";
import { resolveAgentSessionsDir, resolveAgentWorkspaceDir, resolveSessionFile } from "./config.js";

/**
 * Create an AgentSession from a route.
 * @param routeId - The route ID to look up the agent template
 * @param sessionId - The session identifier
 * @param agentName - The agent template name
 * @param rootDir - Root directory for resolving paths
 */
export function createAgentSession(
	routeId: string,
	sessionId: string,
	agentName: string,
	rootDir: string,
	modelFile: string,
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

	const modelManager = new ModelManager(modelFile);
	const resourceLoader = new DefaultResourceLoader({
		skillPaths: template.skills,
		noSkills: template.skills === undefined,
	});
	const sessionManager = new SessionManager(true, sessionFile);

	return new AgentSession(
		workspaceDir,
		sessionManager,
		resourceLoader,
		modelManager,
		template.model.provider,
		template.model.model,
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
