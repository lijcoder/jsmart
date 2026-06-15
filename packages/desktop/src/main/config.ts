import type { AgentSettings } from "@jsmart/jsmart-harness";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const GLOBAL_DIR_NAME = ".jsmart-coding";
const PROJECT_DIR_NAME = ".jsmart";
const SETTINGS_FILE = "settings.json";
const MODELS_FILE = "models.json";

export interface LoadedConfig {
	projectDir: string;
	globalDir: string;
	projectConfigDir: string;
	sessionsDir: string;
	modelFile: string;
	settings: AgentSettings;
	skillPaths: string[];
}

export function getGlobalDir(): string {
	return join(homedir(), GLOBAL_DIR_NAME);
}

function getProjectConfigDir(projectDir: string): string {
	return join(projectDir, PROJECT_DIR_NAME);
}

export function getSessionsDir(projectDir: string): string {
	const projectHash = simpleHash(projectDir);
	return join(homedir(), GLOBAL_DIR_NAME, "sessions", projectHash);
}

export function getAllSessionsRoot(): string {
	return join(homedir(), GLOBAL_DIR_NAME, "sessions");
}

function loadJsonFile<T>(filePath: string): T | null {
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(readFileSync(filePath, "utf-8")) as T;
	} catch {
		return null;
	}
}

function resolveSkillPaths(settings: AgentSettings, projectConfigDir: string): string[] {
	const paths: string[] = [];
	// Always include .jsmart/skills
	paths.push(resolve(projectConfigDir, "skills"));
	for (const p of settings.skillPaths ?? []) {
		if (p.startsWith(".")) {
			paths.push(resolve(projectConfigDir, p));
		} else {
			paths.push(resolve(p));
		}
	}
	return paths;
}

export function loadConfig(projectDir: string): LoadedConfig {
	const globalDir = getGlobalDir();
	const projectConfigDir = getProjectConfigDir(projectDir);
	const sessionsDir = getSessionsDir(projectDir);

	const globalSettings = loadJsonFile<AgentSettings>(join(globalDir, SETTINGS_FILE)) ?? {};
	const projectSettings = loadJsonFile<AgentSettings>(join(projectConfigDir, SETTINGS_FILE)) ?? {};
	const settings: AgentSettings = { ...globalSettings, ...projectSettings };

	const skillPaths = resolveSkillPaths(settings, projectConfigDir);

	const projectModelFile = join(projectConfigDir, MODELS_FILE);
	const modelFile = existsSync(projectModelFile) ? projectModelFile : join(globalDir, MODELS_FILE);

	// Ensure sessions directory exists
	if (!existsSync(sessionsDir)) {
		mkdirSync(sessionsDir, { recursive: true });
	}

	return {
		projectDir,
		globalDir,
		projectConfigDir,
		sessionsDir,
		modelFile,
		settings,
		skillPaths,
	};
}

/**
 * Generate session file path: <sessionsDir>/<hash>-<uuid>.jsonl
 */
function simpleHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash + char) | 0;
	}
	return Math.abs(hash).toString(16).padStart(8, "0");
}

export function generateSessionFilePath(sessionsDir: string, _projectDir: string, sessionId?: string): string {
	const uuid = sessionId ?? crypto.randomUUID();
	return join(sessionsDir, `${uuid}.jsonl`);
}

/**
 * Detect project directory by walking up from cwd.
 * Looks for .jsmart/ or .git.
 */
export function detectProjectDir(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		if (existsSync(join(current, PROJECT_DIR_NAME)) || existsSync(join(current, ".git"))) {
			return current;
		}
		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}
	return resolve(cwd);
}

// ── Session Listing ───────────────────────────────────────────

export interface SessionMeta {
	id: string;
	workspace: string;
	title: string;
	mtime: number;
	hash: string;
}

export interface SessionIndex {
	workspaces: Record<string, SessionEntry[]>;
	workspaceOrder?: string[];
}

interface SessionEntry {
	id: string;
	title: string;
	mtime: number;
	hash?: string;
}

const INDEX_FILE = "sessions.json";

function getIndexPath(): string {
	return join(homedir(), GLOBAL_DIR_NAME, INDEX_FILE);
}

function loadIndex(): SessionIndex {
	const path = getIndexPath();
	if (!existsSync(path)) return { workspaces: {} };
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return { workspaces: {} };
	}
}

function saveIndex(index: SessionIndex): void {
	const globalDir = join(homedir(), GLOBAL_DIR_NAME);
	if (!existsSync(globalDir)) mkdirSync(globalDir, { recursive: true });
	writeFileSync(getIndexPath(), JSON.stringify(index, null, 2), "utf-8");
}

/** Add or update a session in the index */
export function addSessionToIndex(workspace: string, sessionId: string, title: string): void {
	const index = loadIndex();
	const entries = index.workspaces[workspace] ?? [];
	const existing = entries.find((e) => e.id === sessionId);
	if (existing) {
		existing.mtime = Date.now();
		// Only update title if it's not the default placeholder
		if (title && title !== "未命名") {
			existing.title = title;
		}
	} else {
		entries.push({
			id: sessionId,
			title: title || "未命名",
			mtime: Date.now(),
			hash: simpleHash(workspace),
		});
	}
	index.workspaces[workspace] = entries;
	saveIndex(index);
}

/** Remove a session from the index and delete its file */
export function removeSessionFromIndex(sessionId: string): void {
	const index = loadIndex();
	for (const [ws, entries] of Object.entries(index.workspaces)) {
		index.workspaces[ws] = entries.filter((e) => e.id !== sessionId);
		// Keep empty workspace entries — user can explicitly remove them
	}
	saveIndex(index);

	// Delete session file — walk all project hash dirs
	const allSessionsRoot = getAllSessionsRoot();
	if (!existsSync(allSessionsRoot)) return;
	const sessionFile = `${sessionId}.jsonl`;
	for (const dir of readdirSync(allSessionsRoot)) {
		const filePath = join(allSessionsRoot, dir, sessionFile);
		if (existsSync(filePath)) {
			unlinkSync(filePath);
			return;
		}
	}
}

/** Update a session title anywhere in the index */
export function updateSessionTitle(sessionId: string, title: string): boolean {
	const trimmedTitle = title.trim();
	if (!trimmedTitle) return false;

	const index = loadIndex();
	for (const entries of Object.values(index.workspaces)) {
		const existing = entries.find((e) => e.id === sessionId);
		if (existing) {
			existing.title = trimmedTitle;
			existing.mtime = Date.now();
			saveIndex(index);
			return true;
		}
	}
	return false;
}

/** List all sessions from the index, grouped by workspace */
export function listAllSessions(): SessionMeta[] {
	const index = loadIndex();
	const result: SessionMeta[] = [];
	for (const [workspace, entries] of Object.entries(index.workspaces)) {
		for (const e of entries) {
			result.push({
				id: e.id,
				workspace,
				title: e.title,
				mtime: e.mtime,
				hash: e.hash ?? simpleHash(workspace),
			});
		}
	}
	return result;
}

/** Load session messages from a .jsonl file, returns parsed messages */
export function loadSessionMessages(projectDir: string, sessionId: string): unknown[] {
	const sessionsDir = getSessionsDir(projectDir);
	const filePath = join(sessionsDir, `${sessionId}.jsonl`);
	if (!existsSync(filePath)) return [];

	const lines = readFileSync(filePath, "utf-8").trim().split("\n");
	const messages: unknown[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message) {
				messages.push(entry.message);
			}
		} catch {
			// skip malformed lines
		}
	}
	return messages;
}

/** List all workspace directories from the index (including empty ones) */
export function listWorkspaces(): string[] {
	const index = loadIndex();
	if (index.workspaceOrder && index.workspaceOrder.length > 0) {
		// Return in persisted order, ensure all current workspaces are included
		const current = new Set(Object.keys(index.workspaces));
		const ordered = index.workspaceOrder.filter((w) => current.has(w));
		// Append any workspaces not yet in the order list
		for (const w of current) {
			if (!ordered.includes(w)) ordered.push(w);
		}
		return ordered;
	}
	return Object.keys(index.workspaces);
}

/** Remove a workspace and all its sessions from the index */
export function removeWorkspace(workspace: string): void {
	const index = loadIndex();
	const entries = index.workspaces[workspace] ?? [];
	delete index.workspaces[workspace];
	// Remove from workspaceOrder if present
	if (index.workspaceOrder) {
		index.workspaceOrder = index.workspaceOrder.filter((w) => w !== workspace);
	}
	saveIndex(index);

	// Delete all session files for this workspace
	const sessionsDir = getSessionsDir(workspace);
	if (existsSync(sessionsDir)) {
		for (const entry of entries) {
			const filePath = join(sessionsDir, `${entry.id}.jsonl`);
			if (existsSync(filePath)) {
				unlinkSync(filePath);
			}
		}
	}
}

/** Reorder workspaces — persists the new workspace order */
export function reorderWorkspaces(newOrder: string[]): void {
	const index = loadIndex();
	index.workspaceOrder = newOrder;
	saveIndex(index);
}

/** Reorder sessions within a workspace */
export function reorderSessions(workspace: string, sessionIds: string[]): void {
	const index = loadIndex();
	const entries = index.workspaces[workspace];
	if (!entries) return;

	const entryMap = new Map(entries.map((e) => [e.id, e]));
	index.workspaces[workspace] = sessionIds.filter((id) => entryMap.has(id)).map((id) => entryMap.get(id)!);

	saveIndex(index);
}
