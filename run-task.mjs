#!/usr/bin/env node
/**
 * run-task.mjs — 编程方式运行一个任务并生成 session 文件
 *
 * 用法: node run-task.mjs "你的任务描述"
 */

import { CodingSession, loadConfig } from "@jsmart/jsmart-coding-agent";

const prompt = process.argv[2] || `写一个 loc.ts 工具，统计 packages/harness/src/ 下各文件类型的代码行数。完成后在 tools/index.ts 中注册它。`;

const projectDir = process.cwd();
const { config } = loadConfig();

const session = new CodingSession(projectDir, config);

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt(prompt);

console.log(`\n\nSession saved: ${session.getSessionFilePath()}`);
