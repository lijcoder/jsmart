// Harness core - agent session management, tools, compaction, etc.
// For gateway/channel/routing functionality, import from @jsmart/jsmart-gateway

export type { AgentSessionEvent, AgentSessionEventListener, ResultState } from "./agent-session.js";
export { AgentSession } from "./agent-session.js";
export type { CompactionResult, CompactionSettings, CutPointResult } from "./compaction.js";
export {
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	estimateTotalTokens,
	findCutPoint,
	generateSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction.js";
export type { ExecOptions, ExecResult, Executor } from "./executor.js";
export { createExecutor, HostExecutor } from "./executor.js";

export { ModelManager } from "./model-manager.js";
export type { BuildSystemPromptOptions } from "./prompts.js";
export { buildSystemPrompt, formatSkillsForPrompt } from "./prompts.js";
export type { DefaultResourceLoaderOptions, ResourceLoader } from "./resource-manager.js";
export { DefaultResourceLoader } from "./resource-manager.js";
export type {
	CompactionEntry,
	FileEntry,
	SessionContext,
	SessionEntry,
	SessionHeader,
	SessionInfo,
	SessionMessageEntry,
} from "./session-manager.js";
export { SessionManager } from "./session-manager.js";
export type { LoadSkillsFromDirOptions, LoadSkillsResult, Skill } from "./skills.js";
export { loadSkillsFromDir } from "./skills.js";

export { createTools } from "./tools/index.js";
