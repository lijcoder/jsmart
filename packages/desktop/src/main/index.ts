import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from "electron";
import { join } from "path";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { SessionManager } from "./session-manager.js";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let forceQuit = false;

export const sessionManager = new SessionManager();

function getIconPath(): string {
	return join(__dirname, "..", "..", "resources", "icon.png");
}

function createTray(): void {
	const icon = nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 });
	tray = new Tray(icon);
	tray.setToolTip("JSmart Desktop");

	const contextMenu = Menu.buildFromTemplate([
		{
			label: "显示 / 隐藏",
			click: () => toggleWindow(),
		},
		{ type: "separator" },
		{
			label: "退出",
			click: () => {
				forceQuit = true;
				app.quit();
			},
		},
	]);

	tray.setContextMenu(contextMenu);
	tray.on("click", () => toggleWindow());
}

function toggleWindow(): void {
	if (!mainWindow) {
		createWindow();
		return;
	}
	if (mainWindow.isVisible()) {
		mainWindow.hide();
	} else {
		mainWindow.show();
		mainWindow.focus();
	}
}

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

	// Close → hide to tray instead of quitting
	mainWindow.on("close", (event) => {
		if (!forceQuit) {
			event.preventDefault();
			mainWindow?.hide();
		}
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
	app.dock?.setIcon(nativeImage.createFromPath(getIconPath()));

	createTray();
	registerIpcHandlers(sessionManager);
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		} else {
			mainWindow?.show();
			mainWindow?.focus();
		}
	});
});

// Never quit when all windows are closed — app lives in tray
app.on("window-all-closed", () => {
	// do nothing, tray keeps app alive
});

app.on("before-quit", () => {
	forceQuit = true;
	sessionManager.destroyAll();
	tray?.destroy();
	tray = null;
});
