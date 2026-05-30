import type { TextContent } from "@jsmart/jsmart-ai";
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
		const fsProvide = new NodeFsProvider({ cwd: tempDir });
		const bashTool = createBashTool(shellProvide, fsProvide);
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
				PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
			},
		});
		const bashEnvTool = createBashTool(shellEnvProvide, fsProvide);
		result = await bashEnvTool.execute("1", { command: "echo $PATH" });
		console.log(result);
	});

	it("bash tool truncation", async () => {
		const shellProvide = new NodeShellProvider({ cwd: tempDir });
		const fsProvide = new NodeFsProvider({ cwd: tempDir });
		const bashTool = createBashTool(shellProvide, fsProvide);

		// 生成 60KB 输出，超过 50KB 限制
		// 每行 "line-XXXXX\n" 约 12 字节，生成 6000 行 ≈ 72KB
		const genCmd = "awk 'BEGIN{for(i=0;i<6000;i++)printf \"line-%05d\\n\",i}'";

		// 默认 tail=true，保留尾部
		const tailResult = await bashTool.execute("1", { command: genCmd });
		const tailText = (tailResult.content[0] as TextContent).text;
		console.log("--- tail truncation notice ---");
		console.log(tailText.slice(-200)); // 只打印末尾看 notice

		expect(tailText).toMatch(/^\[exit 0\]/);
		expect(tailText).toMatch(/stdout truncated.*tail/);
		expect(tailText).toMatch(/full output:.*bash_output_/);
		expect(tailText).toContain("line-05999"); // 尾部内容应保留
		expect(tailText).not.toContain("line-00000"); // 头部内容应被截掉

		// tail=false，保留头部
		const headResult = await bashTool.execute("1", { command: genCmd, tail: false });
		const headText = (headResult.content[0] as TextContent).text;
		console.log("--- head truncation notice ---");
		console.log(headText.slice(-200));

		expect(headText).toMatch(/stdout truncated.*head/);
		expect(headText).toContain("line-00000"); // 头部内容应保留
		expect(headText).not.toContain("line-05999"); // 尾部内容应被截掉
	});

	it("read tool", async () => {
		const text = "1111111111\n2222222222\n3333333333";
		const filePath = join(tempDir, "test.txt");
		writeFileSync(filePath, text);
		const readTool = createReadTool(fsProvider);
		const result = await readTool.execute("1", { path: filePath });
		const resultText = (result.content[0] as TextContent).text;
		console.log(result);
		// 内容行带行号
		expect(resultText).toContain("1: 1111111111");
		expect(resultText).toContain("2: 2222222222");
		expect(resultText).toContain("3: 3333333333");
		// 末尾状态行
		expect(resultText).toMatch(/End of file — 3 lines total\./);
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
		console.log(result);
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
