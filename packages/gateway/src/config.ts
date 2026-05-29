import { type AgentSettings, AgentSettingsSchema } from "@jsmart/jsmart-harness";
import { type Static, Type } from "@sinclair/typebox";
import AjvModule from "ajv";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const Ajv = (AjvModule as any).default || AjvModule;
const ajv = new Ajv();

/** Agent template */
const AgentTemplateSchema = Type.Object({
	agentSettings: Type.Optional(AgentSettingsSchema),
});

/**
 * Single route definition.
 *
 * Core fields (shared by all channels):
 *   id        — unique route identifier
 *   agent     — agent template name to use
 *   sessionId — optional fixed session ID (channel provides dynamically if omitted)
 *   match     — open dictionary; each channel interprets its own keys
 *
 * Channel-specific extensions (e.g. threadMode for Feishu) are allowed
 * via the `& Record<string, unknown>` intersection.
 */
const RouteSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	agent: Type.String({ minLength: 1 }),
	/**
	 * Optional sessionId. If omitted, the channel provides it dynamically:
	 * - Feishu: uses message chatId
	 * - Console: required (no dynamic source)
	 */
	sessionId: Type.Optional(Type.String({ minLength: 1 })),
	/**
	 * Open match criteria — each channel interprets its own keys.
	 * Examples:
	 *   Feishu:  { chatId: "oc_xxx", userId: "user_123" }
	 *   Console: {}  (empty = match all)
	 *   Telegram: { chatId: "12345", isGroup: true }
	 */
	match: Type.Record(Type.String(), Type.Unknown()),
});

/**
 * Loose channel config schema — only validates structure common to all channels.
 * Each channel validates its own fields at runtime.
 */
const ChannelConfigSchema = Type.Object({
	type: Type.String({ minLength: 1 }),
	routes: Type.Array(RouteSchema),
});

const SettingsSchema = Type.Object({
	agentTemplates: Type.Record(Type.String(), AgentTemplateSchema),
	channels: Type.Record(Type.String(), ChannelConfigSchema),
	channelDirs: Type.Optional(Type.Array(Type.String())),
	agentSettings: Type.Optional(AgentSettingsSchema),
});

ajv.addSchema(SettingsSchema, "Settings");

// ── Types ───────────────────────────────────────────────────────────

export type { AgentSettings } from "@jsmart/jsmart-harness";
export type AgentTemplate = Static<typeof AgentTemplateSchema>;

/**
 * Route type: core fields + arbitrary channel-specific extensions.
 *
 * Core fields: id, agent, sessionId?, match
 * Extensions (accessed via type assertion in channel code):
 *   Feishu:  route.threadMode?: boolean
 *   Telegram: route.isGroup?: boolean
 *   etc.
 */
export type Route = Static<typeof RouteSchema> & Record<string, unknown>;

/** Loose channel config — each channel validates its own fields at runtime */
export type ChannelConfig = Static<typeof ChannelConfigSchema> & Record<string, unknown>;

export interface Settings {
	agentTemplates: Record<string, AgentTemplate>;
	channels: Record<string, ChannelConfig>;
	/**
	 * Additional directories to scan for channel extensions.
	 * Each subdirectory under a channelDir whose name matches a channel `type`
	 * must contain a `channel.js` entry point.
	 *
	 * Default: the built-in `channels/` directory inside the gateway package.
	 * Paths can be absolute or relative to the config file's parent directory.
	 */
	channelDirs?: string[];
	agentSettings?: AgentSettings;
}

// ── Directory Resolution ────────────────────────────────────────────

/** Resolve agent directory: {rootDir}/agents/{agentName} */
export function resolveAgentDir(rootDir: string, agentName: string): string {
	return resolve(rootDir, "agents", agentName);
}

/** Resolve agent sessions directory: {rootDir}/agents/{agentName}/sessions */
export function resolveAgentSessionsDir(rootDir: string, agentName: string): string {
	return resolve(rootDir, "agents", agentName, "sessions");
}

/** Resolve agent workspace directory: {rootDir}/agents/{agentName}/workspace */
export function resolveAgentWorkspaceDir(rootDir: string, agentName: string): string {
	return resolve(rootDir, "agents", agentName, "workspace");
}

/** Resolve session file path: {rootDir}/agents/{agentName}/sessions/{sessionId}.jsonl */
export function resolveSessionFile(rootDir: string, agentName: string, sessionId: string): string {
	return resolve(rootDir, "agents", agentName, "sessions", `${sessionId}.jsonl`);
}

// ── Config Loading ──────────────────────────────────────────────────

/** Replace ${ENV_VAR} patterns with process.env values */
function substituteEnvVars(value: string): string {
	return value.replace(/\$\{(\w+)\}/g, (_match, envName: string) => {
		const envValue = process.env[envName];
		if (envValue === undefined) {
			throw new Error(`Environment variable ${envName} is not set (referenced in config)`);
		}
		return envValue;
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

export interface LoadSettingsResult {
	settings: Settings;
	rootDir: string;
	modelFile: string;
	error: string | undefined;
}

export function loadSettings(configPath: string): LoadSettingsResult {
	const resolvedPath = resolve(configPath);

	if (!existsSync(resolvedPath)) {
		return { settings: {} as Settings, rootDir: "", modelFile: "", error: `Config file not found: ${resolvedPath}` };
	}

	try {
		const content = readFileSync(resolvedPath, "utf-8");
		const raw: unknown = JSON.parse(content);

		// Validate schema
		const validate = ajv.getSchema("Settings")!;
		if (!validate(raw)) {
			const errors =
				validate.errors?.map((e: any) => `  - ${e.instancePath || "root"}: ${e.message}`).join("\n") ||
				"Unknown schema error";
			return {
				settings: {} as Settings,
				rootDir: "",
				modelFile: "",
				error: `Invalid settings schema:\n${errors}\n\nFile: ${resolvedPath}`,
			};
		}

		const settings = raw as Settings;
		const rootDir = resolve(resolvedPath, "..");
		const modelFile = resolve(rootDir, "models.json");

		// Substitute env vars in channels
		const substitutedChannels: Record<string, ChannelConfig> = {};
		for (const [key, ch] of Object.entries(settings.channels)) {
			substitutedChannels[key] = substituteEnvInObject(ch as Record<string, unknown>) as ChannelConfig;
		}
		settings.channels = substitutedChannels;

		return { settings, rootDir, modelFile, error: undefined };
	} catch (error) {
		if (error instanceof SyntaxError) {
			return {
				settings: {} as Settings,
				rootDir: "",
				modelFile: "",
				error: `Failed to parse settings: ${error.message}\n\nFile: ${resolvedPath}`,
			};
		}
		return {
			settings: {} as Settings,
			rootDir: "",
			modelFile: "",
			error: `Failed to load settings: ${error instanceof Error ? error.message : error}\n\nFile: ${resolvedPath}`,
		};
	}
}
