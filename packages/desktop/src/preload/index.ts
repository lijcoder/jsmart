import type { AgentSessionEvent } from "@jsmart/jsmart-harness";
import { contextBridge, ipcRenderer } from "electron";

export interface SessionMeta {
	id: string;
	workspace: string;
	title: string;
	mtime: number;
	hash: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
}

export interface JSmartAPI {
	session: {
		create: (projectDir?: string, sessionId?: string) => Promise<SessionInfo>;
		delete: (id: string) => Promise<boolean>;
		list: () => Promise<SessionInfo[]>;
		prompt: (id: string, text: string) => Promise<void>;
		abort: (id: string) => Promise<void>;
		changeModel: (id: string, provider: string, model: string) => Promise<{ success: boolean; error?: string }>;
		getInfo: (id: string) => Promise<SessionInfo | null>;
		getModels: () => Promise<ModelInfo[]>;
		setThinkingLevel: (id: string, level: string) => Promise<boolean>;
		getThinkingLevel: (id: string) => Promise<string>;
		onEvent: (callback: (sessionId: string, event: AgentSessionEvent) => void) => () => void;
	};
	app: {
		selectProject: () => Promise<string | null>;
		listSessions: () => Promise<SessionMeta[]>;
		loadHistory: (projectDir: string, sessionId: string) => Promise<unknown[]>;
		updateTitle: (sessionId: string, title: string) => Promise<void>;
		listWorkspaces: () => Promise<string[]>;
		removeWorkspace: (workspace: string) => Promise<void>;
		minimize: () => Promise<void>;
		maximize: () => Promise<void>;
		close: () => Promise<void>;
		isMaximized: () => Promise<boolean>;
		openExternal: (url: string) => Promise<void>;
		onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
	};
}

const api: JSmartAPI = {
	session: {
		create: (projectDir?: string, sessionId?: string) => ipcRenderer.invoke("session:create", projectDir, sessionId),
		delete: (id: string) => ipcRenderer.invoke("session:delete", id),
		list: () => ipcRenderer.invoke("session:list"),
		prompt: (id: string, text: string) => ipcRenderer.invoke("session:prompt", id, text),
		abort: (id: string) => ipcRenderer.invoke("session:abort", id),
		changeModel: (id: string, provider: string, model: string) =>
			ipcRenderer.invoke("session:changeModel", id, provider, model),
		getInfo: (id: string) => ipcRenderer.invoke("session:getInfo", id),
		getModels: () => ipcRenderer.invoke("session:getModels"),
		setThinkingLevel: (id: string, level: string) => ipcRenderer.invoke("session:setThinkingLevel", id, level),
		getThinkingLevel: (id: string) => ipcRenderer.invoke("session:getThinkingLevel", id),
		onEvent: (callback: (sessionId: string, event: AgentSessionEvent) => void) => {
			const handler = (_event: Electron.IpcRendererEvent, sessionId: string, e: AgentSessionEvent) => {
				callback(sessionId, e);
			};
			ipcRenderer.on("session:event", handler);
			return () => {
				ipcRenderer.removeListener("session:event", handler);
			};
		},
	},
	app: {
		selectProject: () => ipcRenderer.invoke("app:selectProject"),
		listSessions: () => ipcRenderer.invoke("app:listSessions"),
		loadHistory: (projectDir: string, sessionId: string) =>
			ipcRenderer.invoke("app:loadHistory", projectDir, sessionId),
		updateTitle: (sessionId: string, title: string) => ipcRenderer.invoke("app:updateTitle", sessionId, title),
		listWorkspaces: () => ipcRenderer.invoke("app:listWorkspaces"),
		removeWorkspace: (workspace: string) => ipcRenderer.invoke("app:removeWorkspace", workspace),
		minimize: () => ipcRenderer.invoke("app:minimize"),
		maximize: () => ipcRenderer.invoke("app:maximize"),
		close: () => ipcRenderer.invoke("app:close"),
		isMaximized: () => ipcRenderer.invoke("app:isMaximized"),
		openExternal: (url: string) => ipcRenderer.invoke("app:openExternal", url),
		onMaximizeChange: (callback: (maximized: boolean) => void) => {
			const handler = () => {
				ipcRenderer.invoke("app:isMaximized").then(callback);
			};
			window.addEventListener("resize", handler);
			return () => window.removeEventListener("resize", handler);
		},
	},
};

contextBridge.exposeInMainWorld("jsmart", api);
