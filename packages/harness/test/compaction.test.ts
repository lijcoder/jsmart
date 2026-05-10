import { compact } from "../src/compaction.js";
import { ModelManager } from "../src/model-manager.js";
import { SessionManager } from "../src/session-manager.js";

const providerName = "my";
const modelName = "qwen3.5-plus";
const sessionFile = "/Users/lijie/.jie/test/sessions/test_1.jsonl";
const modelFile = "/Users/lijie/.jie/test/models.json";

const modelManager = new ModelManager(modelFile);
const sessionManager = new SessionManager(true, sessionFile);
const model = modelManager.find(providerName, modelName);
const apiKey = await modelManager.getApiKeyForProvider(providerName);

if (!model || !apiKey) {
	console.log("error: model not found");
	process.exit(1);
}
const result = await compact(sessionManager.getEntries(), model, apiKey);
console.log(result);
