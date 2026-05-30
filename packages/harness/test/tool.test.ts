import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFsProvider, NodeShellProvider } from "../src/providers/node.js";
import type { FsProvider } from "../src/providers/types.js";
import { createBashTool } from "../src/tools/bash.js";
import { createEditTool } from "../src/tools/edit.js";
import { createGrepTool } from "../src/tools/grep.js";
import { createLsTool } from "../src/tools/ls.js";
import { createReadTool } from "../src/tools/read.js";
import { createWriteTool } from "../src/tools/write.js";

describe("tool node fs", () => {
	let tempDir: string;
	let fsProvider: FsProvider;

	beforeEach(() => {
		tempDir = join(tmpdir(), `jsmart-tool-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		fsProvider = new NodeFsProvider({ cwd: tempDir });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("bash tool", async () => {
		const shellProvide = new NodeShellProvider({ cwd: tempDir });
		const bashTool = createBashTool(shellProvide);
		let result = await bashTool.execute("1", { command: "pwd" });
		console.log(result);
		result = await bashTool.execute("1", { command: "touch bash.txt" });
		console.log(result);
		result = await bashTool.execute("1", { command: "ls -l -a" });
		console.log(result);
		result = await bashTool.execute("1", { command: "echo $PATH" });
		console.log(result);

		const shellEnvProvide = new NodeShellProvider({
			cwd: tempDir,
			env: {
				PATH: "/Users/lijie/.local/programming/js/nodejs/node-v22.17.1/bin:/Users/lijie/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
			},
		});
		const bashEnvTool = createBashTool(shellEnvProvide);
		result = await bashEnvTool.execute("1", { command: "echo $PATH" });
		console.log(result);
	});

	it("read tool", async () => {
		const text = "1111111111\n2222222222\n3333333333";
		const textDiff = `1: 1111111111\n2: 2222222222\n3: 3333333333`;
		const filePath = join(tempDir, "test.txt");
		writeFileSync(filePath, text);
		const readTool = createReadTool(fsProvider);
		const result = await readTool.execute("1", { path: filePath });
		const diff = result.content[0].type === "text" && result.content[0].text === textDiff;
		expect(diff).toBe(true);
	});

	it("write tool", async () => {
		const text = "1111111111\n2222222222\n3333333333";
		const filePath = join(tempDir, "test.txt");
		const writeTool = createWriteTool(fsProvider);
		const result = await writeTool.execute("1", { path: filePath, content: text });
		console.log(result);
		const textDiff = readFileSync(filePath, "utf-8");
		expect(text).toBe(textDiff);
	});

	it("edit tool", async () => {
		const text = "1111111111\n2222222222\n111133333";
		const filePath = join(tempDir, "test.txt");
		writeFileSync(filePath, text);
		const editTool = createEditTool(fsProvider);
		const result = await editTool.execute("1", {
			path: filePath,
			oldText: "1111",
			newText: "aaaa",
		});
		console.log(result);
		const textDiff = readFileSync(filePath, "utf-8");
		expect(textDiff).toBe("aaaa111111\n2222222222\n111133333");
	});

	it("ls tool", async () => {
		writeFileSync(`${join(tempDir, "test.txt")}`, "test");
		const lsTool = createLsTool(fsProvider);
		const result = await lsTool.execute("1", {
			dirPath: tempDir,
		});
		expect(Array.isArray(result.details)).toBe(true);
		expect(result.details.length).toBe(1);
	});

	it("grep tool", async () => {
		const text = "1111111111\n2222222222\n111133333";
		const filePath = join(tempDir, "test.txt");
		writeFileSync(filePath, text);
		const grepTool = createGrepTool(fsProvider);
		const result = await grepTool.execute("1", {
			pattern: "1111",
		});
		console.log(result);
	});
});
