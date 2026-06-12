import { BrowserWindow, dialog, ipcMain } from "electron";
import { detectProjectDir, listAllSessions, loadSessionMessages, updateSessionTitle } from "./config.js";
import type { SessionManager } from "./session-manager.js";

export function registerIpcHandlers(sessionManager: SessionManager): void {
	// ── Session CRUD ────────────────────────────────────────────

	ipcMain.handle("session:create", async (_event, projectDir?: string, sessionId?: string) => {
		const dir = projectDir ?? detectProjectDir(process.cwd());
		const senderWindow = BrowserWindow.fromWebContents(_event.sender);
		if (!senderWindow) throw new Error("No window");

		const info = sessionManager.create(
			dir,
			(sessionId, event) => {
				senderWindow.webContents.send("session:event", sessionId, event);
			},
			sessionId,
		);
		return info;
	});

	ipcMain.handle("session:delete", async (_event, id: string) => {
		return sessionManager.delete(id);
	});

	ipcMain.handle("session:list", async () => {
		return sessionManager.list();
	});

	// ── Session Actions ─────────────────────────────────────────

	ipcMain.handle("session:prompt", async (_event, id: string, text: string) => {
		sessionManager.prompt(id, text);
	});

	ipcMain.handle("session:abort", async (_event, id: string) => {
		sessionManager.abort(id);
	});

	ipcMain.handle("session:changeModel", async (_event, id: string, provider: string, model: string) => {
		return sessionManager.changeModel(id, provider, model);
	});

	ipcMain.handle("session:getInfo", async (_event, id: string) => {
		return sessionManager.getInfo(id);
	});

	// ── App ─────────────────────────────────────────────────────

	ipcMain.handle("app:selectProject", async () => {
		const result = await dialog.showOpenDialog({
			properties: ["openDirectory"],
			title: "Select Project Directory",
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		return result.filePaths[0];
	});

	ipcMain.handle("app:listSessions", async () => {
		return listAllSessions();
	});

	ipcMain.handle("app:loadHistory", async (_event, projectDir: string, sessionId: string) => {
		return loadSessionMessages(projectDir, sessionId);
	});

	ipcMain.handle("app:updateTitle", async (_event, sessionId: string, title: string) => {
		updateSessionTitle(sessionId, title);
	});

	// ── Window Controls ──────────────────────────────────────────

	ipcMain.handle("app:minimize", async (_event) => {
		BrowserWindow.fromWebContents(_event.sender)?.minimize();
	});

	ipcMain.handle("app:maximize", async (_event) => {
		const win = BrowserWindow.fromWebContents(_event.sender);
		if (!win) return;
		if (win.isMaximized()) {
			win.unmaximize();
		} else {
			win.maximize();
		}
	});

	ipcMain.handle("app:close", async (_event) => {
		BrowserWindow.fromWebContents(_event.sender)?.close();
	});

	ipcMain.handle("app:isMaximized", async (_event) => {
		return BrowserWindow.fromWebContents(_event.sender)?.isMaximized() ?? false;
	});
}
