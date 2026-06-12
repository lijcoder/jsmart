import type { AgentSessionEvent } from "@jsmart/jsmart-harness";
import { contextBridge, ipcRenderer } from "electron";

export interface SessionMeta {
	id: string;
	workspace: string;
	title: string;
	mtime: number;
	hash: string;
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
		onEvent: (callback: (sessionId: string, event: AgentSessionEvent) => void) => () => void;
	};
	app: {
		selectProject: () => Promise<string | null>;
		listSessions: () => Promise<SessionMeta[]>;
		loadHistory: (projectDir: string, sessionId: string) => Promise<unknown[]>;
		updateTitle: (sessionId: string, title: string) => Promise<void>;
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
	},
};

contextBridge.exposeInMainWorld("jsmart", api);
