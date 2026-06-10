import * as fs from "node:fs";
import * as path from "node:path";
import { defineConfig } from "vitest/config";

function loadTestEnv(): Record<string, string> {
	try {
		const configPath = path.resolve(__dirname, "test/.env");
		return JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch {
		return {};
	}
}

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30_000,
		env: loadTestEnv(),
	},
});
