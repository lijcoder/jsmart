// Harness core - agent session management, tools, compaction, etc.
// For gateway/channel/routing functionality, import from @jsmart/jsmart-gateway

export type {
	AgentSessionEvent,
	AgentSessionEventListener,
	AgentSessionOptions,
	ResultState,
} from "./agent-session.js";
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
export {
	buildSystemPrompt,
	DEFAULT_SYSTEM_PROMPT_TEMPLATE,
	formatSkillsForPrompt,
	loadPromptTemplate,
	loadPromptTemplateFromDirs,
} from "./prompts.js";
export type { FsProvider, NodeFsProviderOptions, NodeShellProviderOptions, ShellProvider } from "./providers/index.js";
export { NodeFsProvider, NodeShellProvider } from "./providers/index.js";
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
export type { AgentSettings, ModelSettings, RetrySettings, Settings } from "./settings-manager.js";
export {
	AgentSettingsSchema,
	CompactionSettingsSchema,
	ModelSettingsSchema,
	RetrySettingsSchema,
	SettingsManager,
} from "./settings-manager.js";
export type { LoadSkillsFromDirOptions, LoadSkillsResult, Skill } from "./skills.js";
export { loadSkillsFromDir } from "./skills.js";
export {
	createBashTool,
	createEditTool,
	createGrepTool,
	createLsTool,
	createMemoryTool,
	createReadTool,
	createSessionSearchTool,
	createWriteTool,
} from "./tools/index.js";
