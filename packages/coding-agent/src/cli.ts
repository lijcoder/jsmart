#!/usr/bin/env node
/**
 * Coding Agent CLI entry point.
 *
 * Usage:
 *   npx tsx src/cli.ts              # uses current directory
 *   npx tsx src/cli.ts --init       # initialize global config
 */

import * as readline from "readline";
import { CodingSession } from "./coding-session.js";
import { initGlobalConfig, loadConfig } from "./config.js";
import { colorize, handleAgentEvent } from "./event-output.js";

function parseCommand(input: string): string[] {
	return input.split(/\s+/);
}

function show(text: string): void {
	process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
	// Handle --init flag
	if (process.argv.includes("--init")) {
		const globalDir = initGlobalConfig();
		show(`Global config initialized at: ${globalDir}`);
		process.exit(0);
	}

	// Load configuration
	const { config, error } = loadConfig();
	if (error || !config) {
		show(`Error loading config: ${error}`);
		process.exit(1);
	}

	show(`=== Coding Agent ===`);
	show(`Project: ${config.projectDir}`);
	show(`Config: ${config.projectDirPath}`);
	show(`Model file: ${config.modelFile}`);
	show(`Skills: ${config.skillPaths.length > 0 ? config.skillPaths.join(", ") : "(none)"}`);
	show("");

	// Create coding session
	const session = new CodingSession(config.projectDir, config);

	// Subscribe to agent events
	session.subscribe(handleAgentEvent);

	show(`Session: ${session.getSessionFilePath()}`);
	show(`Model: ${session.getCurrentModel()}`);
	show("");
	show("Commands:");
	show("  /model              - Show current model");
	show("  /models             - List all available models");
	show("  /set model <p> <m>  - Change model");
	show("  /compact            - Compact context");
	show("  /tokens             - Show token count");
	show("  /session            - Show session file path");
	show("  /quit               - Exit");
	show("");

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
			show(colorize("Goodbye!", "result"));
			rl.close();
			break;
		}

		if (command === "/model") {
			show(`Current model: ${session.getCurrentModel()}`);
			continue;
		}

		if (command === "/models") {
			const models = session.getAllModels();
			if (models.length === 0) {
				show("No models available");
			} else {
				show(models.join("\n"));
			}
			continue;
		}

		if (command === "/compact") {
			const tokens = session.getContextTokens();
			show(`Context tokens: ${tokens}`);
			const result = await session.compact();
			if (result.isSuccess && result.result) {
				show(`Compacted ${result.result.tokensBefore} -> ${session.getContextTokens()} tokens`);
				show(`Summary:\n${result.result.summary}`);
			} else {
				show(`Error: ${result.error}`);
			}
			continue;
		}

		if (command === "/tokens") {
			show(`Context tokens: ${session.getContextTokens()}`);
			continue;
		}

		if (command === "/session") {
			show(`Session file: ${session.getSessionFilePath()}`);
			continue;
		}

		if (command.startsWith("/set model")) {
			const parts = parseCommand(command);
			if (parts.length < 4) {
				show("Usage: /set model <provider> <model>");
			} else {
				const providerName = parts[2];
				const modelName = parts[3];
				const { isSuccess, error } = session.changeModel(providerName, modelName);
				show(isSuccess ? colorize("Model changed", "result") : `${colorize("Error", "error")}: ${error}`);
			}
			continue;
		}

		// Regular prompt
		if (answer.trim()) {
			await session.prompt(answer.trim());
		}
	}
}

main().catch((err) => {
	show(`${colorize("Fatal Error", "error")}: ${err}`);
	process.exit(1);
});
