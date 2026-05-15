#!/usr/bin/env node
/**
 * Gateway CLI entry point.
 *
 * Usage:
 *   npx tsx src/cli.ts              # uses ~/.jsmart
 *   npx tsx src/cli.ts --mode debug # uses ~/.jsmart-debug
 */

import { homedir } from "os";
import { join } from "path";
import { loadSettings } from "./config.js";
import { Gateway } from "./gateway.js";
import { logger } from "./logger.js";

function resolveRootDir(): string {
	const modeIndex = process.argv.indexOf("--mode");
	const mode = modeIndex !== -1 ? process.argv[modeIndex + 1] : undefined;
	const isDebug = mode === "debug";
	const dirName = isDebug ? ".jsmart-debug" : ".jsmart";
	return join(homedir(), dirName);
}

async function main(): Promise<void> {
	const rootDir = resolveRootDir();
	const configPath = join(rootDir, "settings.json");
	const modelFile = join(rootDir, "models.json");

	logger.info("[Gateway] Root dir: %s", rootDir);

	// Load settings
	const { settings, error } = loadSettings(configPath);
	if (error) {
		logger.error(error);
		process.exit(1);
	}

	logger.info("[Gateway] Config loaded from: %s", configPath);
	logger.info("[Gateway] Model file: %s", modelFile);
	logger.info("[Gateway] Agent templates: %s", Object.keys(settings.agentTemplates).join(", "));

	// Create gateway
	const gateway = new Gateway(settings, rootDir, modelFile);

	// Register channels from config
	await gateway.registerChannelsFromConfig(settings);

	// Start
	await gateway.start();

	logger.info("[Gateway] Started. Press Ctrl+C to stop.");

	// Graceful shutdown
	const shutdown = async () => {
		logger.info("[Gateway] Shutting down...");
		await gateway.stop();
		logger.info("[Gateway] Stopped.");
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	logger.error("[Gateway] Fatal error: %s", err);
	process.exit(1);
});
