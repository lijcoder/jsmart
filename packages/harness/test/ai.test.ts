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
	switch (event.type) {
		case "start":
			process.stdout.write(`\n-- start --`);
			break;
		case "text_start":
			process.stdout.write(`\n-- text_start --\n`);
			break;
		case "text_delta":
			process.stdout.write(event.delta);
			break;
		case "text_end":
			process.stdout.write(`\n-- text_end --`);
			break;
		case "thinking_start":
			process.stdout.write(`\n-- thinking_start --\n`);
			break;
		case "thinking_delta":
			process.stdout.write(event.delta);
			break;
		case "thinking_end":
			process.stdout.write(`\n-- thinking_end --`);
			break;
		case "toolcall_start":
			break;
		case "toolcall_delta":
			break;
		case "toolcall_end":
			break;
		case "done":
			process.stdout.write(`\n-- done [${event.reason}] --\n`);
			break;
		case "error":
			process.stdout.write(`\n-- error [${event.reason}]--\n`);
			process.stdout.write(`${event.error.errorMessage}\n`);
			break;
	}
}

process.stdout.write(` `);
