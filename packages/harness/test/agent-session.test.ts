import * as readline from "readline";
import { AgentSession } from "../src/agent-session.js";
import { ModelManager } from "../src/model-manager.js";
import { DefaultResourceLoader } from "../src/resource-manager.js";
import { SessionManager } from "../src/session-manager.js";
import { SettingsManager } from "../src/settings-manager.js";
import { agentSubscriberFormat } from "./agent-session.out.js";

const workspace = process.env.JIE_TEST_WORKSPACE!;
const sessionFile = process.env.JIE_TEST_SESSION_FILE!;
const modelFile = process.env.JIE_TEST_MODEL_FILE!;
const providerName = process.env.JIE_TEST_PROVIDER_NAME!;
const modelName = process.env.JIE_TEST_MODEL_NAME!;
const skillPaths = process.env.JIE_TEST_SKILL_PATHS!.split(",");
const modelManager = new ModelManager(modelFile);
const resourceLoader = new DefaultResourceLoader({ skillPaths: skillPaths, noSkills: false });
const sessionManager = new SessionManager(true, sessionFile);
const settingsManager = new SettingsManager({});
const agentSession = new AgentSession(
	workspace,
	settingsManager,
	sessionManager,
	resourceLoader,
	modelManager,
	providerName,
	modelName,
);
agentSession.subscribe(agentSubscriberFormat);

function parseCommand(input: string): string[] {
	const parts = input.split(" ");
	return parts;
}

function show(text: string): void {
	process.stdout.write(`${text}\n`);
}

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

while (true) {
	const answer = await new Promise<string>((resolve) => {
		rl.question("> ", resolve);
	});

	const command = answer.trim().toLowerCase();
	if (command === "/quit") {
		rl.close();
		break;
	}
	if (command === "/models") {
		const models = agentSession.getAllModelName();
		if (models.length === 0) {
			show("model empty");
		} else {
			show(`${models.join("\n")}`);
		}
		continue;
	}
	if (command === "/model") {
		show(`${agentSession.getModelName()}`);
		continue;
	}
	if (command === "/compact") {
		const tokens = agentSession.getContextTokens();
		show(`Context tokens: ${tokens}`);
		const result = await agentSession.runCompaction();
		if (result.isSuccess && result.result) {
			show(`Compacted ${result.result.tokensBefore} -> ${agentSession.getContextTokens()} tokens`);
			show(`Summary:\n${result.result.summary}`);
		} else {
			show(`Error: ${result.error}`);
		}
		continue;
	}
	if (command === "/tokens") {
		show(`Context tokens: ${agentSession.getContextTokens()}`);
		continue;
	}
	if (command.startsWith("/set model")) {
		const parts = parseCommand(command);
		if (parts.length < 3) {
			show("error: invalid argument");
		} else {
			const providerName = parts[2];
			const modelName = parts[3];
			const { isSuccess, error } = agentSession.changeModel(providerName, modelName);
			const msg = isSuccess ? "success" : error;
			show(`${msg}`);
		}
		continue;
	}

	if (answer.trim()) {
		await agentSession.prompt(answer.trim());
	}
}
