import { Agent } from "@jsmart/jsmart-agent-core";
import type { Api, Model } from "@jsmart/jsmart-ai";
import { createExecutor } from "../src/executor.js";
import { ModelManager } from "../src/model-manager.js";
import { buildSystemPrompt } from "../src/prompts.js";
import { loadSkillsFromDir } from "../src/skills.js";
import { createTools } from "../src/tools/index.js";
import { agentSubscriberFormat } from "./agent.out.js";

const providerName = "my";
const modelName = "qwen3.5-plus";
const modelJsonPath: string = "/Users/lijie/.jie/test/models.json";
const modelManager = ModelManager.create(modelJsonPath);
const model: Model<Api> | undefined = modelManager.find(providerName, modelName);

if (!model) {
	console.error(`Model not found: provider=${providerName}, model=${modelName}`);
	process.exit(1);
}

const executor = createExecutor();
const tools = createTools(executor);
const agent = new Agent({
	initialState: {
		model,
		thinkingLevel: "minimal",
	},
	toolExecution: "sequential",
	getApiKey: async (provider) => {
		return modelManager.getApiKeyForProvider(provider);
	},
});
agentSubscriberFormat(agent);
agent.state.tools = tools;
const skills = loadSkillsFromDir({ dir: "/Users/lijie/.jie/test/skills", source: "test" }).skills;
const systemPrompt = buildSystemPrompt({
	workspace: "/Users/lijie/work/code/sandbox-paas",
	selectedTools: tools,
	skills: skills,
});
agent.state.systemPrompt = systemPrompt;

await agent.prompt("总结网页内容https://view.inews.qq.com/a/20260410A03J1H00?scene=news-skill");

console.log(`\nStatistics:\nmessage count: ${agent.state.messages.length}`);
