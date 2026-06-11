import {
	AgentSession,
	createBashTool,
	createEditTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	loadPromptTemplateFromDirs,
	ModelManager,
	NodeFsProvider,
	NodeShellProvider,
	SessionManager,
	SettingsManager,
} from "@jsmart/jsmart-harness";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { LoadedConfig } from "./config.js";

function loadAgentsFile(dir: string): string | null {
	const agentsPath = join(dir, "AGENTS.md");
	if (!existsSync(agentsPath)) return null;
	try {
		return readFileSync(agentsPath, "utf-8");
	} catch {
		return null;
	}
}

export function createAgent(projectDir: string, config: LoadedConfig, sessionId: string): AgentSession {
	const sessionFile = join(config.sessionsDir, `${sessionId}.jsonl`);

	const settingsManager = new SettingsManager({
		...config.settings,
		skillPaths: config.skillPaths,
	});
	const modelManager = new ModelManager(config.modelFile);
	const sessionManager = new SessionManager(true, sessionFile);

	const fsProvider = new NodeFsProvider({ cwd: projectDir });
	const shellProvider = new NodeShellProvider({ cwd: projectDir });

	const promptTemplate = loadPromptTemplateFromDirs([config.projectConfigDir, config.globalDir]);

	const tools = [
		createBashTool(shellProvider, fsProvider),
		createReadTool(fsProvider),
		createWriteTool(fsProvider),
		createEditTool(fsProvider),
		createLsTool(fsProvider),
		createGrepTool(fsProvider),
	];

	const agentsContent = loadAgentsFile(projectDir);

	// Configure memory if default model is available for summarization
	const defaultModelSettings = settingsManager.getDefaultModel();
	const extractionModel = defaultModelSettings
		? (modelManager.find(defaultModelSettings.provider, defaultModelSettings.model) ?? undefined)
		: undefined;

	const memoryConfig = extractionModel
		? {
				memoryDir: join(config.globalDir, "memory"),
				userId: "default",
				projectId: projectDir.replace(/[^a-zA-Z0-9_-]/g, "_"),
				summarizationModel: extractionModel,
			}
		: undefined;

	return new AgentSession(projectDir, settingsManager, sessionManager, modelManager, {
		promptTemplate: promptTemplate ?? undefined,
		customContent: agentsContent ?? undefined,
		tools,
		memory: memoryConfig,
	});
}
