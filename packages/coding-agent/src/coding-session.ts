import type { AgentMessage, AgentTool } from "@jsmart/jsmart-agent-core";
import type { Message } from "@jsmart/jsmart-ai";
import {
	AgentSession,
	createBashTool,
	createEditTool,
	createGrepTool,
	createLsTool,
	createMemorySearchTool,
	createReadTool,
	createWriteTool,
	loadPromptTemplateFromDirs,
	ModelManager,
	NodeFsProvider,
	NodeShellProvider,
	SessionManager,
	SettingsManager,
} from "@jsmart/jsmart-harness";
import { MemoryManager } from "@jsmart/jsmart-memory";
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
	// memory
	private memoryManager?: MemoryManager;
	private readonly memoryCount: number = 5;
	private memoryTurnCount: number = 0;
	private memoryAgentMessages: AgentMessage[] = [];

	constructor(projectDir: string, config: ResolvedConfig) {
		// Generate session file path (use sessionId to resume if provided)
		const sessionFile = generateSessionFilePath(config.sessionsDir, projectDir, config.sessionId);

		// Create managers (settingsManager extracted so we can read the default model for memory extraction)
		const settingsManager = new SettingsManager({ ...config.settings, skillPaths: config.skillPaths });
		const modelManager = new ModelManager(config.modelFile);
		const sessionManager = new SessionManager(true, sessionFile);
		const promptTemplate = loadPromptTemplateFromDirs([config.projectDirPath, config.globalDir]);
		const fsProvider = new NodeFsProvider({ cwd: projectDir });
		const shellProvider = new NodeShellProvider({ cwd: projectDir });

		// Set up memory manager (project-scoped, stored under .jsmart/memory/)
		const defaultModelSettings = settingsManager.getDefaultModel();
		const extractionModel = defaultModelSettings
			? (modelManager.find(defaultModelSettings.provider, defaultModelSettings.model) ?? undefined)
			: undefined;
		const extractionApiKey = extractionModel
			? (modelManager.getApiKeyForProviderSync(extractionModel.provider) ?? "")
			: "";
		if (extractionModel !== undefined) {
			this.memoryManager = new MemoryManager({
				memoryDir: join(config.projectDirPath, "memory"),
				extractionModel,
				extractionApiKey,
			});
			this.memoryManager.ensureDir();
		}

		// Combine AGENTS.md with the memory index for system prompt injection
		const agentsContent = loadAgentsFile(config.projectDir);
		const memoryContent = this.memoryManager?.formatForPrompt();
		const customContent = [agentsContent, memoryContent].filter(Boolean).join("\n\n---\n\n") || undefined;

		const tools: AgentTool<any>[] = [
			createBashTool(shellProvider, fsProvider),
			createReadTool(fsProvider),
			createWriteTool(fsProvider),
			createEditTool(fsProvider),
			createLsTool(fsProvider),
			createGrepTool(fsProvider),
		];
		if (this.memoryManager) {
			tools.push(createMemorySearchTool(this.memoryManager));
		}

		this.agentSession = new AgentSession(projectDir, settingsManager, sessionManager, modelManager, {
			promptTemplate: promptTemplate ?? undefined,
			customContent: customContent,
			tools: tools,
		});

		// Background memory extraction hooks
		this.agentSession.subscribe((event) => {
			if (event.type === "agent_end") {
				if (this.memoryManager) {
					// Count turns; trigger LLM extraction every N turns.
					// Filter to standard AI messages — agent may carry custom message types
					++this.memoryTurnCount;
					this.memoryAgentMessages.push(...event.messages);
					if (this.memoryTurnCount >= this.memoryCount) {
						this.memoryManager?.generalMemory(toAiMessages(this.memoryAgentMessages));
						this.memoryTurnCount = 0;
						this.memoryAgentMessages = [];
					}
				}
			}
		});
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

/**
 * Filters an AgentMessage array down to standard AI Message types.
 * The agent runtime may attach custom message types (e.g. CompactionSummaryMessage)
 * that framework-agnostic packages like jsmart-memory don't know about.
 */
function toAiMessages(messages: { role?: string }[]): Message[] {
	return messages.filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
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
