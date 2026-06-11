import { app, BrowserWindow, nativeImage, shell } from "electron";
import { join } from "path";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { SessionManager } from "./session-manager.js";

let mainWindow: BrowserWindow | null = null;

export const sessionManager = new SessionManager();

function createWindow(): void {
	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		title: "JSmart Desktop",
		webPreferences: {
			preload: join(__dirname, "../preload/index.mjs"),
			sandbox: false,
			contextIsolation: true,
		},
	});

	// Prevent external links from opening in the Electron window
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});

	// Load the renderer
	if (process.env.ELECTRON_RENDERER_URL) {
		mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
		// Open DevTools in dev mode
		mainWindow.webContents.openDevTools();
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}

	mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
		console.error("Renderer failed to load:", errorCode, errorDescription);
	});
}

app.whenReady().then(() => {
	// Set dock icon — works in both dev and production
	const iconPath = join(__dirname, "..", "..", "resources", "icon.png");
	app.dock?.setIcon(nativeImage.createFromPath(iconPath));

	registerIpcHandlers(sessionManager);
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("before-quit", () => {
	sessionManager.destroyAll();
});
