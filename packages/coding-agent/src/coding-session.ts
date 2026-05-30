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
		// Generate session file path (use sessionId to resume if provided)
		const sessionFile = generateSessionFilePath(config.sessionsDir, projectDir, config.sessionId);

		const modelManager = new ModelManager(config.modelFile);
		const sessionManager = new SessionManager(true, sessionFile);
		const promptTemplate = loadPromptTemplateFromDirs([config.projectDirPath, config.globalDir]);
		const customContent = loadAgentsFile(config.projectDir);
		const fsProvider = new NodeFsProvider({ cwd: projectDir });
		const shellProvider = new NodeShellProvider({ cwd: projectDir });
		const tools = [
			createBashTool(shellProvider, fsProvider),
			createReadTool(fsProvider),
			createWriteTool(fsProvider),
			createEditTool(fsProvider),
			createLsTool(fsProvider),
			createGrepTool(fsProvider),
		];

		this.agentSession = new AgentSession(
			projectDir,
			new SettingsManager({ ...config.settings, skillPaths: config.skillPaths }),
			sessionManager,
			modelManager,
			{
				promptTemplate: promptTemplate ?? undefined,
				customContent: customContent ?? undefined,
				tools: tools,
			},
		);
	}

	/** Subscribe to agent events */
	subscribe(listener: Parameters<typeof this.agentSession.subscribe>[0]): () => void {
		return this.agentSession.subscribe(listener);
	}

	/** Send a prompt to the agent */
	async prompt(text: string): Promise<void> {
		await this.agentSession.prompt(text);
	}

	/** Abort the current agent run, if one is active. */
	abort(): Promise<void> {
		return this.agentSession.abort();
	}

	/** Check if the agent is currently processing a prompt. */
	isProcessing(): boolean {
		return this.agentSession.isProcessing();
	}

	/** Change the current model */
	changeModel(provider: string, model: string): ResultState<void> {
		return this.agentSession.changeModel(provider, model);
	}

	/** Run context compaction */
	async compact(): Promise<ResultState<{ summary: string; tokensBefore: number }>> {
		const { summary, tokensBefore } = await this.agentSession.compact();
		return { isSuccess: true, result: { summary: summary, tokensBefore: tokensBefore } };
	}

	/** Get current context token count */
	getContextTokens(): number {
		return this.agentSession.getContextTokens();
	}

	/** Get the system prompt */
	getSystemPrompt(): string {
		return this.agentSession.getSystemPrompt();
	}

	/** Get all available models */
	getAllModels(): string[] {
		return this.agentSession.getAllModelName();
	}

	/** Get current model name */
	getCurrentModel(): string {
		return this.agentSession.getModelName();
	}

	/** Get session file path */
	getSessionFilePath(): string | undefined {
		return this.agentSession.getSessionFilePath();
	}

	/** Check if compaction is needed */
	needsCompaction(contextWindow: number): boolean {
		return this.agentSession.needsCompaction(contextWindow);
	}

	/** Get message count */
	messageCount(): number {
		return this.agentSession.messageCount();
	}
}

/** Load AGENTS.md from the given directory, returning its content or null */
function loadAgentsFile(dir: string): string | null {
	const agentsPath = join(dir, "AGENTS.md");
	if (!existsSync(agentsPath)) {
		return null;
	}
	try {
		return readFileSync(agentsPath, "utf-8");
	} catch {
		return null;
	}
}
