import { type Context, type Model, streamSimple } from "@jsmart/jsmart-ai";

const model: Model<"openai-completions"> = {
	id: "qwen3.5-flash",
	name: "qwen3.5-flash",
	api: "openai-completions",
	provider: "qwen",
	baseUrl: "http://localhost:7888/proxy/direct/newapi/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
	headers: {},
};

const context: Context = {
	messages: [{ role: "user", content: "请介绍一下你自己", timestamp: Date.now() }],
};

const stream = streamSimple(model, context, {
	reasoning: "medium",
	apiKey: "sk-debug-pi-ai",
});

for await (const event of stream) {
	process.stdout.write(`${JSON.stringify(event, null)}`);
	process.stdout.write(`\n`);
}

process.stdout.write(` `);
