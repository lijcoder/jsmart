import { type Static, Type } from "@sinclair/typebox";

// ── Schema ───────────────────────────────────────────────────────────

const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);

export const ModelSettingsSchema = Type.Object({
	provider: Type.String({ minLength: 1 }),
	model: Type.String({ minLength: 1 }),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});

export const RetrySettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	maxRetries: Type.Optional(Type.Number()),
	baseDelayMs: Type.Optional(Type.Number()),
});

export const CompactionSettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	reserveTokens: Type.Optional(Type.Number()),
	keepRecentTokens: Type.Optional(Type.Number()),
});

export const AgentSettingsSchema = Type.Object({
	defaultModel: Type.Optional(ModelSettingsSchema),
	fallbackModel: Type.Optional(ModelSettingsSchema),
	compactionModel: Type.Optional(ModelSettingsSchema),
	retry: Type.Optional(RetrySettingsSchema),
	compaction: Type.Optional(CompactionSettingsSchema),
	skillPaths: Type.Optional(Type.Array(Type.String())),
	noSkills: Type.Optional(Type.Boolean()),
});

// ── Types ────────────────────────────────────────────────────────────

export type ModelSettings = Static<typeof ModelSettingsSchema>;
export type RetrySettings = Static<typeof RetrySettingsSchema>;
export type CompactionSettings = Static<typeof CompactionSettingsSchema>;
export type AgentSettings = Static<typeof AgentSettingsSchema>;

// Settings is a superset of AgentSettings with harness-only fields
export interface Settings extends AgentSettings {
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
}

// ── Manager ──────────────────────────────────────────────────────────

export class SettingsManager {
	private settings: Settings;

	constructor(initialGlobal: Settings) {
		this.settings = initialGlobal;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getSkillPaths(): string[] | undefined {
		return this.settings.skillPaths;
	}

	getNoSkills(): boolean {
		return this.settings.noSkills ?? false;
	}

	getDefaultModel(): ModelSettings | undefined {
		return this.settings.defaultModel;
	}

	getFallbackModel(): ModelSettings | undefined {
		return this.settings.fallbackModel;
	}

	getCompactionModel(): ModelSettings | undefined {
		return this.settings.compactionModel;
	}
}
