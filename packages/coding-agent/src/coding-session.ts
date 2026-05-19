import {
	AgentSession,
	DefaultResourceLoader,
	loadPromptTemplateFromDirs,
	ModelManager,
	SessionManager,
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
		// Generate session file path
		const sessionFile = generateSessionFilePath(config.sessionsDir, projectDir);

		// Initialize components (same pattern as agent-session.test.ts)
		const modelManager = new ModelManager(config.modelFile);
		const resourceLoader = new DefaultResourceLoader({
			skillPaths: config.skillPaths,
			noSkills: config.skillPaths.length === 0,
		});
		const sessionManager = new SessionManager(true, sessionFile);

		// Determine default model
		const defaultModel = config.settings.defaultModel;
		const providerName = defaultModel?.provider ?? "openai";
		const modelName = defaultModel?.model ?? "gpt-4o";

		// 从项目 .jsmart 目录加载模板，没有则从全局目录加载
		const promptTemplate = loadPromptTemplateFromDirs([config.projectDirPath, config.globalDir]);

		// 加载项目根目录下的 AGENTS.md 作为自定义内容
		const customContent = loadAgentsFile(config.projectDir);

		// Create agent session
		this.agentSession = new AgentSession(
			projectDir,
			sessionManager,
			resourceLoader,
			modelManager,
			providerName,
			modelName,
			{
				promptTemplate: promptTemplate ?? undefined,
				customContent: customContent ?? undefined,
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
		return this.agentSession.runCompaction();
	}

	/** Get current context token count */
	getContextTokens(): number {
		return this.agentSession.getContextTokens();
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
