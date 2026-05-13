import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProjectDir, generateSessionFilePath, initGlobalConfig, loadConfig } from "../src/config.js";

describe("config", () => {
	let testDir: string;
	let globalDir: string;
	let projectDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `jsmart-coding-test-${Date.now()}`);
		globalDir = join(testDir, ".jsmart-coding");
		projectDir = join(testDir, "my-project");
		mkdirSync(globalDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("detectProjectDir", () => {
		it("should find .jsmart directory", () => {
			mkdirSync(join(projectDir, ".jsmart"));
			const result = detectProjectDir(projectDir);
			expect(result).toBe(projectDir);
		});

		it("should find git root", () => {
			mkdirSync(join(projectDir, ".git"));
			const result = detectProjectDir(projectDir);
			expect(result).toBe(projectDir);
		});

		it("should fallback to cwd if no markers found", () => {
			const result = detectProjectDir(projectDir);
			expect(result).toBe(projectDir);
		});
	});

	describe("loadConfig", () => {
		it("should load with no config files", () => {
			// Override homedir for testing
			const originalHomedir = process.env.HOME;
			process.env.HOME = testDir;

			const { config, error } = loadConfig(projectDir);
			expect(error).toBeUndefined();
			expect(config).not.toBeNull();
			expect(config!.projectDir).toBe(projectDir);

			process.env.HOME = originalHomedir;
		});

		it("should merge global and project settings", () => {
			const originalHomedir = process.env.HOME;
			process.env.HOME = testDir;

			// Create global settings
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(
				join(globalDir, "settings.json"),
				JSON.stringify({
					defaultModel: { provider: "openai", model: "gpt-4o" },
					skillPaths: ["/global/skills"],
				}),
			);

			// Create project settings
			const projectConfigDir = join(projectDir, ".jsmart");
			mkdirSync(projectConfigDir, { recursive: true });
			writeFileSync(
				join(projectConfigDir, "settings.json"),
				JSON.stringify({
					defaultModel: { provider: "anthropic", model: "claude-sonnet-4" },
					skillPaths: ["./skills"],
				}),
			);

			const { config } = loadConfig(projectDir);
			expect(config).not.toBeNull();
			expect(config!.settings.defaultModel).toEqual({ provider: "anthropic", model: "claude-sonnet-4" });
			expect(config!.skillPaths).toContain("/global/skills");

			process.env.HOME = originalHomedir;
		});
	});

	describe("generateSessionFilePath", () => {
		it("should create session file path with hash and uuid", () => {
			const sessionsDir = join(projectDir, ".jsmart", "sessions");
			const filePath = generateSessionFilePath(sessionsDir, projectDir);
			expect(filePath).toContain(sessionsDir);
			expect(filePath).toMatch(/[a-f0-9]{8}-[a-f0-9-]{36}\.jsonl$/);
			expect(existsSync(sessionsDir)).toBe(true);
		});
	});

	describe("initGlobalConfig", () => {
		it("should create default config files", () => {
			const originalHomedir = process.env.HOME;
			process.env.HOME = testDir;

			const result = initGlobalConfig();
			expect(result).toBe(globalDir);
			expect(existsSync(join(globalDir, "settings.json"))).toBe(true);
			expect(existsSync(join(globalDir, "models.json"))).toBe(true);

			const settings = JSON.parse(readFileSync(join(globalDir, "settings.json"), "utf-8"));
			expect(settings.defaultModel).toEqual({ provider: "openai", model: "gpt-4o" });

			process.env.HOME = originalHomedir;
		});
	});
});
