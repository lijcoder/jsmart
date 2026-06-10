import type { AgentTool } from "@jsmart/jsmart-agent-core";
import type { Skill } from "@jsmart/jsmart-harness";
import {
	AgentSession,
	createBashTool,
	createEditTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DefaultResourceLoader,
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
	private workspace: string;
	private tools: AgentTool<any, any>[];
	private skills: Skill[];

	constructor(projectDir: string, config: ResolvedConfig) {
		this.workspace = projectDir;

		// Generate session file path (use sessionId to resume if provided)
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

		this.tools = [
			createBashTool(shellProvider, fsProvider),
			createReadTool(fsProvider),
			createWriteTool(fsProvider),
			createEditTool(fsProvider),
			createLsTool(fsProvider),
			createGrepTool(fsProvider),
		];

		const resourceLoader = new DefaultResourceLoader({ skillPaths: config.skillPaths });
		this.skills = resourceLoader.getSkills();

		this.agentSession = new AgentSession(projectDir, settingsManager, sessionManager, modelManager, {
			promptTemplate: promptTemplate ?? undefined,
			customContent: agentsContent ?? undefined,
			tools: this.tools,
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

	/** Get workspace directory */
	getWorkspace(): string {
		return this.workspace;
	}

	/** Get tools available to the agent */
	getTools(): AgentTool<any, any>[] {
		return this.tools;
	}

	/** Get skills loaded for this session */
	getSkills(): Skill[] {
		return this.skills;
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
