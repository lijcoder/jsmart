import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { ajv, type CodingSettings } from "./config-schema.js";

// ── Constants ──────────────────────────────────────────────────────

const GLOBAL_DIR_NAME = ".jsmart-coding";
const PROJECT_DIR_NAME = ".jsmart";
const SESSIONS_DIR_NAME = "sessions";
const SETTINGS_FILE = "settings.json";
const MODELS_FILE = "models.json";

// ── Types ──────────────────────────────────────────────────────────

export interface ResolvedConfig {
	projectDir: string;
	globalDir: string;
	projectDirPath: string;
	sessionsDir: string;
	settings: CodingSettings;
	modelFile: string;
	skillPaths: string[];
	/** Session ID used to resume a previous session (optional) */
	sessionId?: string;
}

export interface ConfigLoadResult {
	config: ResolvedConfig | null;
	error: string | undefined;
}

// ── Directory Resolution ───────────────────────────────────────────

/**
 * Detect project directory by walking up from cwd.
 * Looks for .jsmart/ directory or git root.
 */
export function detectProjectDir(cwd: string): string {
	let current = resolve(cwd);

	while (true) {
		// Check for .jsmart/ directory
		if (existsSync(join(current, PROJECT_DIR_NAME))) {
			return current;
		}

		// Check for git root
		if (existsSync(join(current, ".git"))) {
			return current;
		}

		const parent = dirname(current);
		if (parent === current) {
			// Reached filesystem root
			break;
		}
		current = parent;
	}

	// Fallback: use cwd itself
	return resolve(cwd);
}

/** Get global config directory: ~/.jsmart-coding/ */
export function getGlobalDir(): string {
	return join(homedir(), GLOBAL_DIR_NAME);
}

/** Get project config directory: <projectDir>/.jsmart/ */
export function getProjectDirPath(projectDir: string): string {
	return join(projectDir, PROJECT_DIR_NAME);
}

/** Get sessions directory: <projectDir>/.jsmart/sessions/ */
export function getSessionsDir(projectDir: string): string {
	return join(projectDir, PROJECT_DIR_NAME, SESSIONS_DIR_NAME);
}

// ── Config Loading ─────────────────────────────────────────────────

/** Replace ${ENV_VAR} patterns with process.env values */
function substituteEnvVars(value: string): string {
	return value.replace(/\$\{(\w+)\}/g, (_match, envName: string) => {
		const envValue = process.env[envName];
		return envValue !== undefined ? envValue : _match;
	});
}

/** Deep-substitute env vars in a config object */
function substituteEnvInObject<T extends Record<string, unknown>>(obj: T): T {
	const result = {} as T;
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === "string") {
			(result as Record<string, unknown>)[key] = substituteEnvVars(value);
		} else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			(result as Record<string, unknown>)[key] = substituteEnvInObject(value as Record<string, unknown>);
		} else if (Array.isArray(value)) {
			(result as Record<string, unknown>)[key] = value.map((item) =>
				typeof item === "object" && item !== null ? substituteEnvInObject(item as Record<string, unknown>) : item,
			);
		} else {
			(result as Record<string, unknown>)[key] = value;
		}
	}
	return result;
}

/** Load and validate a settings.json file */
function loadSettingsFile(filePath: string): CodingSettings | null {
	if (!existsSync(filePath)) {
		return null;
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		const raw: unknown = JSON.parse(content);

		// Validate schema
		const validate = ajv.getSchema("CodingSettings")!;
		if (!validate(raw)) {
			console.error(`Invalid settings schema in ${filePath}:`, validate.errors);
			return null;
		}

		const settings = raw as CodingSettings;
		return substituteEnvInObject(settings);
	} catch (error) {
		console.error(`Failed to load settings from ${filePath}:`, error);
		return null;
	}
}

/** Merge two settings objects (project overrides global) */
function mergeSettings(global: CodingSettings, project: CodingSettings): CodingSettings {
	const merged: CodingSettings = {};

	// defaultModel: project overrides global
	merged.defaultModel = project.defaultModel ?? global.defaultModel;

	// skillPaths: merge both (project paths appended)
	const globalSkills = global.skillPaths ?? [];
	const projectSkills = project.skillPaths ?? [];
	if (globalSkills.length > 0 || projectSkills.length > 0) {
		merged.skillPaths = [...globalSkills, ...projectSkills];
	}

	return merged;
}

/** Resolve skill paths to absolute paths */
function resolveSkillPaths(settings: CodingSettings, _projectDir: string, projectDirPath: string): string[] {
	const skillPaths = settings.skillPaths ?? [];
	const resolved: string[] = [];

	// Always include project .jsmart/skills directory as the first skill path
	resolved.push(resolve(projectDirPath, "skills"));

	for (const p of skillPaths) {
		if (p.startsWith(".") || p.startsWith("./")) {
			// Relative path: resolve against project .jsmart/ directory
			resolved.push(resolve(projectDirPath, p));
		} else {
			// Absolute path
			resolved.push(resolve(p));
		}
	}

	return resolved;
}

/** Resolve model file path (project first, fallback to global) */
function resolveModelFile(projectDirPath: string, globalDir: string): string {
	const projectModelFile = join(projectDirPath, MODELS_FILE);
	if (existsSync(projectModelFile)) {
		return projectModelFile;
	}
	return join(globalDir, MODELS_FILE);
}

export interface SessionFileInfo {
	name: string;
	mtime: Date;
}

/**
 * List available session files in the sessions directory.
 * Returns an array of filenames with modification times, sorted by mtime descending.
 */
export function listSessionFiles(sessionsDir: string): SessionFileInfo[] {
	if (!existsSync(sessionsDir)) {
		return [];
	}
	try {
		return readdirSync(sessionsDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => ({
				name: f,
				mtime: statSync(join(sessionsDir, f)).mtime,
			}))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
	} catch {
		return [];
	}
}

/**
 * Generate session file path: <sessionsDir>/<project-pwd-hash>-<uuid>.jsonl
 *
 * If `sessionId` is provided, looks for an existing file matching that ID
 * (either the full filename or a partial match on the UUID portion).
 */
export function generateSessionFilePath(sessionsDir: string, projectDir: string, sessionId?: string): string {
	// Create sessions directory if it doesn't exist
	if (!existsSync(sessionsDir)) {
		mkdirSync(sessionsDir, { recursive: true });
	}

	const projectHash = simpleHash(projectDir);

	if (sessionId) {
		// Try to find an existing session file matching the sessionId
		const sessionFiles = listSessionFiles(sessionsDir);

		// Match: exact filename match, or filename matches <projectHash>-<sessionId>.jsonl
		for (const f of sessionFiles) {
			if (f.name === sessionId) {
				return join(sessionsDir, f.name);
			}
			// Match by UUID portion: <projectHash>-<uuid>.jsonl
			const expected = `${projectHash}-${sessionId}.jsonl`;
			if (f.name === expected) {
				return join(sessionsDir, f.name);
			}
		}

		// No matching session found - create a new session with the given ID
		const fileName = `${projectHash}-${sessionId}.jsonl`;
		return join(sessionsDir, fileName);
	}

	// No sessionId, generate new random UUID
	const uuid = crypto.randomUUID();
	const fileName = `${projectHash}-${uuid}.jsonl`;
	return join(sessionsDir, fileName);
}

/** Simple hash function for project directory path */
function simpleHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash + char) | 0;
	}
	return Math.abs(hash).toString(16).padStart(8, "0");
}

// ── Main Config Loader ─────────────────────────────────────────────

export function loadConfig(cwd: string = process.cwd(), sessionId?: string): ConfigLoadResult {
	const projectDir = detectProjectDir(cwd);
	const globalDir = getGlobalDir();
	const projectDirPath = getProjectDirPath(projectDir);
	const sessionsDir = getSessionsDir(projectDir);

	// Load settings
	const globalSettings = loadSettingsFile(join(globalDir, SETTINGS_FILE)) ?? {};
	const projectSettings = loadSettingsFile(join(projectDirPath, SETTINGS_FILE)) ?? {};
	const mergedSettings = mergeSettings(globalSettings, projectSettings);

	// Resolve paths
	const skillPaths = resolveSkillPaths(mergedSettings, projectDir, projectDirPath);
	const modelFile = resolveModelFile(projectDirPath, globalDir);

	// Ensure sessions directory exists
	if (!existsSync(sessionsDir)) {
		mkdirSync(sessionsDir, { recursive: true });
	}

	const config: ResolvedConfig = {
		projectDir,
		globalDir,
		projectDirPath,
		sessionsDir,
		settings: mergedSettings,
		modelFile,
		skillPaths,
		sessionId,
	};

	return { config, error: undefined };
}

/** Create default global config directory and files */
export function initGlobalConfig(): string {
	const globalDir = getGlobalDir();
	if (!existsSync(globalDir)) {
		mkdirSync(globalDir, { recursive: true });
	}

	const settingsPath = join(globalDir, SETTINGS_FILE);
	if (!existsSync(settingsPath)) {
		const defaultSettings: CodingSettings = {
			defaultModel: {
				provider: "openai",
				model: "gpt-4o",
			},
			skillPaths: [],
		};
		writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
	}

	const modelsPath = join(globalDir, MODELS_FILE);
	if (!existsSync(modelsPath)) {
		const defaultModels = {
			providers: {},
		};
		writeFileSync(modelsPath, JSON.stringify(defaultModels, null, 2));
	}

	return globalDir;
}
