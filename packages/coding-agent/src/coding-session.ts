import type { AgentTool } from "@jsmart/jsmart-agent-core";
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
import type { ResolvedConfig } from "./config.js";
import { generateSessionFilePath } from "./config.js";

export interface ResultState<T> {
	isSuccess: boolean;
	error?: string;
	result?: T;
}

export class CodingSession {
	private agentSession: AgentSession;

	constructor(projectDir: string, config: ResolvedConfig) {
		const sessionFile = generateSessionFilePath(config.sessionsDir, projectDir, config.sessionId);
		const settingsManager = new SettingsManager({ ...config.settings, skillPaths: config.skillPaths });
		const modelManager = new ModelManager(config.modelFile);
		const sessionManager = new SessionManager(true, sessionFile);
		const promptTemplate = loadPromptTemplateFromDirs([config.projectDirPath, config.globalDir]);
		const fsProvider = new NodeFsProvider({ cwd: projectDir });
		const shellProvider = new NodeShellProvider({ cwd: projectDir });

		const defaultModelSettings = settingsManager.getDefaultModel();
		const extractionModel = defaultModelSettings
			? (modelManager.find(defaultModelSettings.provider, defaultModelSettings.model) ?? undefined)
			: undefined;

		const agentsContent = loadAgentsFile(config.projectDir);

		const tools: AgentTool<any>[] = [
			createBashTool(shellProvider, fsProvider),
			createReadTool(fsProvider),
			createWriteTool(fsProvider),
			createEditTool(fsProvider),
			createLsTool(fsProvider),
			createGrepTool(fsProvider),
		];

		this.agentSession = new AgentSession(projectDir, settingsManager, sessionManager, modelManager, {
			promptTemplate: promptTemplate ?? undefined,
			customContent: agentsContent ?? undefined,
			tools,
			memory: extractionModel
				? {
						memoryDir: join(config.globalDir, "memory"),
						userId: config.userId ?? "default",
						projectId: config.projectId,
						summarizationModel: extractionModel,
					}
				: undefined,
		});
	}

	subscribe(listener: Parameters<typeof this.agentSession.subscribe>[0]): () => void {
		return this.agentSession.subscribe(listener);
	}

	async prompt(text: string): Promise<void> {
		await this.agentSession.prompt(text);
	}

	abort(): Promise<void> {
		return this.agentSession.abort();
	}

	isProcessing(): boolean {
		return this.agentSession.isProcessing();
	}

	changeModel(provider: string, model: string): ResultState<void> {
		return this.agentSession.changeModel(provider, model);
	}

	async compact(): Promise<ResultState<{ summary: string; tokensBefore: number }>> {
		const { summary, tokensBefore } = await this.agentSession.compact();
		return { isSuccess: true, result: { summary, tokensBefore } };
	}

	getContextTokens(): number {
		return this.agentSession.getContextTokens();
	}

	getSystemPrompt(): string {
		return this.agentSession.getSystemPrompt();
	}

	getAllModels(): string[] {
		return this.agentSession.getAllModelName();
	}

	getCurrentModel(): string {
		return this.agentSession.getModelName();
	}

	getSessionFilePath(): string | undefined {
		return this.agentSession.getSessionFilePath();
	}

	getSessionId(): string {
		return this.agentSession.getSessionId();
	}

	needsCompaction(contextWindow: number): boolean {
		return this.agentSession.needsCompaction(contextWindow);
	}

	messageCount(): number {
		return this.agentSession.messageCount();
	}
}

function loadAgentsFile(dir: string): string | null {
	const agentsPath = join(dir, "AGENTS.md");
	if (!existsSync(agentsPath)) return null;
	try {
		return readFileSync(agentsPath, "utf-8");
	} catch {
		return null;
	}
}
