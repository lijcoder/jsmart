import type { AgentSession, AgentSessionEvent } from "@jsmart/jsmart-harness";
import { createAgent } from "./agent-factory.js";
import { addSessionToIndex, type LoadedConfig, loadConfig, removeSessionFromIndex } from "./config.js";

export interface SessionInfo {
	id: string;
	projectDir: string;
	model: string;
	tokens: number;
	createdAt: number;
}

interface SessionState {
	projectDir: string;
	config: LoadedConfig;
	agentSession: AgentSession;
	unsubscribe: () => void;
	eventEmitter: (sessionId: string, event: AgentSessionEvent) => void;
}

export class SessionManager {
	private sessions = new Map<string, SessionState>();

	create(
		projectDir: string,
		eventEmitter: (sessionId: string, event: AgentSessionEvent) => void,
		sessionId?: string,
		title?: string,
	): SessionInfo {
		const id = sessionId ?? crypto.randomUUID();
		const config = loadConfig(projectDir);
		const agentSession = createAgent(projectDir, config, id);
		addSessionToIndex(projectDir, id, title ?? "未命名");

		const unsubscribe = agentSession.subscribe((event) => {
			eventEmitter(id, event);
		});

		this.sessions.set(id, {
			projectDir,
			config,
			agentSession,
			unsubscribe,
			eventEmitter,
		});

		return {
			id,
			projectDir,
			model: agentSession.getModelName(),
			tokens: agentSession.getContextTokens(),
			createdAt: Date.now(),
		};
	}

	delete(id: string): boolean {
		const state = this.sessions.get(id);
		if (state) {
			state.unsubscribe();
			this.sessions.delete(id);
		}
		removeSessionFromIndex(id);
		return !!state;
	}

	prompt(id: string, text: string): void {
		const state = this.sessions.get(id);
		if (!state) throw new Error(`Session not found: ${id}`);
		state.agentSession.prompt(text);
	}

	abort(id: string): void {
		const state = this.sessions.get(id);
		if (!state) throw new Error(`Session not found: ${id}`);
		state.agentSession.abort();
	}

	changeModel(id: string, provider: string, model: string): { success: boolean; error?: string } {
		const state = this.sessions.get(id);
		if (!state) return { success: false, error: `Session not found: ${id}` };
		const result = state.agentSession.changeModel(provider, model);
		return { success: result.isSuccess, error: result.error };
	}

	setThinkingLevel(id: string, level: string): boolean {
		const state = this.sessions.get(id);
		if (!state) return false;
		state.agentSession.setThinkingLevel(level as "off" | "low" | "medium" | "high");
		return true;
	}

	getThinkingLevel(id: string): string {
		const state = this.sessions.get(id);
		return state?.agentSession.getThinkingLevel() ?? "off";
	}

	getInfo(id: string): SessionInfo | null {
		const state = this.sessions.get(id);
		if (!state) return null;
		return {
			id,
			projectDir: state.projectDir,
			model: state.agentSession.getModelName(),
			tokens: state.agentSession.getContextTokens(),
			createdAt: 0,
		};
	}

	list(): SessionInfo[] {
		return [...this.sessions.entries()].map(([id, state]) => ({
			id,
			projectDir: state.projectDir,
			model: state.agentSession.getModelName(),
			tokens: state.agentSession.getContextTokens(),
			createdAt: 0,
		}));
	}

	isProcessing(id: string): boolean {
		return this.sessions.get(id)?.agentSession.isProcessing() ?? false;
	}

	destroyAll(): void {
		for (const [, state] of this.sessions) {
			state.unsubscribe();
		}
		this.sessions.clear();
	}

	getSessionMap(): Map<string, { projectDir: string }> {
		const map = new Map<string, { projectDir: string }>();
		for (const [id, state] of this.sessions) {
			map.set(id, { projectDir: state.projectDir });
		}
		return map;
	}

	getModels(): { id: string; name: string; provider: string }[] {
		for (const state of this.sessions.values()) {
			return state.agentSession.getModels().map((m) => ({
				id: m.id,
				name: m.name,
				provider: m.provider,
			}));
		}
		return [];
	}
}
