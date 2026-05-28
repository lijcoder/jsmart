import type { Api, Model } from "@jsmart/jsmart-ai";
import { type Static, Type } from "@sinclair/typebox";
import AjvModule from "ajv";
import { existsSync, readFileSync } from "fs";

const Ajv = (AjvModule as any).default || AjvModule;
const ajv = new Ajv();

// Schema for OpenRouter routing preferences
const OpenRouterRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

// Schema for OpenAI compatibility settings
const ReasoningEffortMapSchema = Type.Object({
	minimal: Type.Optional(Type.String()),
	low: Type.Optional(Type.String()),
	medium: Type.Optional(Type.String()),
	high: Type.Optional(Type.String()),
	xhigh: Type.Optional(Type.String()),
});

// Schema for Vercel AI Gateway routing preferences
const VercelGatewayRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

const OpenAICompletionsCompatSchema = Type.Object({
	supportsStore: Type.Optional(Type.Boolean()),
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	supportsReasoningEffort: Type.Optional(Type.Boolean()),
	reasoningEffortMap: Type.Optional(ReasoningEffortMapSchema),
	supportsUsageInStreaming: Type.Optional(Type.Boolean()),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
	requiresToolResultName: Type.Optional(Type.Boolean()),
	requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
	requiresThinkingAsText: Type.Optional(Type.Boolean()),
	thinkingFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openrouter"),
			Type.Literal("zai"),
			Type.Literal("qwen"),
			Type.Literal("qwen-chat-template"),
		]),
	),
	openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
	vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
	supportsStrictMode: Type.Optional(Type.Boolean()),
});

const OpenAIResponsesCompatSchema = Type.Object({
	// Reserved for future use
});

const OpenAICompatSchema = Type.Union([OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema]);

// Schema for custom model definition
// Most fields are optional with sensible defaults for local models (Ollama, LM Studio, etc.)
const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({
			input: Type.Number(),
			output: Type.Number(),
			cacheRead: Type.Number(),
			cacheWrite: Type.Number(),
		}),
	),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(OpenAICompatSchema),
});

const ProviderConfigSchema = Type.Object({
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	apiKey: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(OpenAICompatSchema),
	authHeader: Type.Optional(Type.Boolean()),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
});

const ModelsConfigSchema = Type.Object({
	providers: Type.Record(Type.String(), ProviderConfigSchema),
});

ajv.addSchema(ModelsConfigSchema, "ModelsConfig");

type ModelsConfig = Static<typeof ModelsConfigSchema>;

interface ProviderConfig {
	provider: string;
	apiKey?: string;
	headers?: Record<string, string>;
}

/** Result of loading custom models from models.json */
interface CustomModelsResult {
	models: Model<Api>[];
	providerConfigs: Map<string, ProviderConfig>;
	error: string | undefined;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
	return { models: [], providerConfigs: new Map(), error };
}

export class ModelManager {
	private modelsJsonPath: string | undefined;
	private models: Model<Api>[] = [];
	private providerConfigs: Map<string, ProviderConfig> = new Map();
	private loadError: string | undefined = undefined;

	static create(modelsJsonPath?: string): ModelManager {
		return new ModelManager(modelsJsonPath);
	}

	constructor(modelsJsonPath: string | undefined) {
		this.modelsJsonPath = modelsJsonPath;
		this.loadModels();
	}

	private loadModels() {
		// Load custom models from models.json
		const {
			models: customModels,
			providerConfigs: customProviderConfigs,
			error,
		} = this.modelsJsonPath
			? this.loadCustomModels(this.modelsJsonPath)
			: emptyCustomModelsResult("No models.json path provided");

		if (error) {
			this.loadError = error;
		} else {
			this.models = customModels;
			this.providerConfigs = customProviderConfigs;
		}
	}

	private loadCustomModels(modelsJsonPath: string): CustomModelsResult {
		if (!existsSync(modelsJsonPath)) {
			return emptyCustomModelsResult(`${modelsJsonPath} file not found`);
		}
		try {
			const content = readFileSync(modelsJsonPath, "utf-8");
			const config: ModelsConfig = JSON.parse(content);

			// Validate schema
			const validate = ajv.getSchema("ModelsConfig")!;
			if (!validate(config)) {
				const errors =
					validate.errors?.map((e: any) => `  - ${e.instancePath || "root"}: ${e.message}`).join("\n") ||
					"Unknown schema error";
				return emptyCustomModelsResult(`Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`);
			}

			const providerConfigs = new Map<string, ProviderConfig>();
			for (const [providerName, providerConfig] of Object.entries(config.providers)) {
				providerConfigs.set(providerName, {
					provider: providerName,
					apiKey: providerConfig.apiKey,
					headers: providerConfig.headers,
				});
			}

			return { models: this.parseModels(config), providerConfigs: providerConfigs, error: undefined };
		} catch (error) {
			if (error instanceof SyntaxError) {
				return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
			}
			return emptyCustomModelsResult(
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`,
			);
		}
	}

	private parseModels(config: ModelsConfig): Model<Api>[] {
		const models: Model<Api>[] = [];

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // Override-only, no custom models

			for (const modelDef of modelDefs) {
				const api = modelDef.api || providerConfig.api;
				if (!api) continue;

				const compat = modelDef.compat;
				const headers = { ...providerConfig.headers, ...modelDef.headers };

				// Provider baseUrl is required when custom models are defined.
				// Individual models can override it with modelDef.baseUrl.
				const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				models.push({
					id: modelDef.id,
					name: modelDef.name ?? modelDef.id,
					api: api as Api,
					provider: providerName,
					baseUrl: modelDef.baseUrl ?? providerConfig.baseUrl!,
					reasoning: modelDef.reasoning ?? false,
					input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
					cost: modelDef.cost ?? defaultCost,
					contextWindow: modelDef.contextWindow ?? 128000,
					maxTokens: modelDef.maxTokens ?? 16384,
					headers: headers,
					compat,
				} as Model<Api>);
			}
		}
		return models;
	}

	/**
	 * Get any error from loading models.json (undefined if no error).
	 */
	getError(): string | undefined {
		return this.loadError;
	}

	/**
	 * Get all models (built-in + custom).
	 * If models.json had errors, returns only built-in models.
	 */
	getAll(): Model<Api>[] {
		return this.models;
	}

	/**
	 * Find a model by provider and ID.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.models.find((m) => m.provider === provider && m.id === modelId);
	}

	/**
	 * add model
	 */
	addModels(models: Model<Api>[]) {
		this.models.push(...models);
	}

	/**
	 * add Providers
	 */
	addProviders(providers: ProviderConfig[]) {
		for (const p of providers) {
			if (!this.providerConfigs.has(p.provider)) {
				this.providerConfigs.set(p.provider, p);
			}
		}
	}

	/**
	 * Get API key for a provider.
	 */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		const providerApiKey = this.providerConfigs.get(provider)?.apiKey;
		return providerApiKey;
	}
}
