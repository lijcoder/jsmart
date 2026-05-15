# 动态提示词模板方案

## 概述

本方案实现了 harness 系统提示词的动态模板化，模板从文件系统加载，不同应用从不同目录加载 `prompt_template.md` 文件。

## 模板加载规则

| 应用 | 加载路径 | 说明 |
|------|----------|------|
| **Gateway** | `{workspace}/prompt_template.md` | 从 agent 工作目录加载 |
| **Coding-Agent** | 1. `<project>/.jsmart/prompt_template.md`<br>2. `~/.jsmart-coding/prompt_template.md` | 优先项目目录，回退全局目录 |

如果指定目录没有 `prompt_template.md`，则使用 harness 内置的默认模板。

## 核心设计

### 占位符规范

使用 `{{variable}}` 格式作为占位符，支持的变量如下：

| 占位符 | 说明 | 生成方式 |
|--------|------|----------|
| `{{tools}}` | 可用工具列表 | 根据 `selectedTools` 动态生成 |
| `{{guidelines}}` | 使用指南 | 根据工具可用性动态生成 |
| `{{skills}}` | 技能列表 | 根据 `skills` 动态生成 XML 区块 |
| `{{date}}` | 当前日期 | `new Date().toISOString().slice(0,10)` |
| `{{cwd}}` | 工作目录 | 传入的 workspace 路径 |
| `{{custom}}` | 自定义内容 | 应用层传入的额外内容 |

### 条件语法

模板支持轻量级条件判断，控制内容是否展示：

| 语法 | 说明 |
|------|------|
| `{{#if variable}}...{{/if}}` | 变量有值时显示内容 |
| `{{#unless variable}}...{{/unless}}` | 变量无值时显示内容 |
| `{{#if variable}}...{{#else}}...{{/if}}` | 支持 else 分支 |

**示例：**

```
{{#if skills}}
## Available Skills
{{skills}}
{{#else}}
No skills loaded. Use general tools to help.
{{/if}}

{{#unless custom}}
No project-specific rules configured.
{{/unless}}
```

条件判断标准：变量值不为 `undefined` 且不为空字符串 `""` 时视为"有值"。

### 关键特性

1. **有占位符才替换**：模板中没有的占位符不会被替换
2. **文件加载**：模板从 `prompt_template.md` 文件加载
3. **灵活扩展**：支持 `customContent` 传入任意自定义内容
4. **角色自由**：角色定义直接写在模板中，无需占位符

## 使用方式

### Gateway 应用

在工作目录创建 `prompt_template.md`：

```
{rootDir}/agents/{agentName}/workspace/prompt_template.md
```

示例内容：

```markdown
You are a helpful AI assistant.

## Available Tools
{{tools}}

## Guidelines
{{guidelines}}

{{#if skills}}
## Available Skills
{{skills}}
{{/if}}

---
Current date: {{date}}
Working directory: {{cwd}}
```

### Coding-Agent 应用

在项目 `.jsmart` 目录创建 `prompt_template.md`：

```
<project>/.jsmart/prompt_template.md
```

如果没有，会从全局目录回退：

```
~/.jsmart-coding/prompt_template.md
```

示例内容：

```markdown
You are an expert software engineer assistant.

## Tools
{{tools}}

## Development Guidelines
{{guidelines}}

{{#if custom}}
## Project-Specific Rules
{{custom}}
{{/if}}

{{#if skills}}
## Available Skills
{{skills}}
{{#else}}
No specialized skills loaded.
{{/if}}

---
Date: {{date}}
Project root: {{cwd}}
```

## API

### 模板加载函数

```typescript
// 从单个目录加载
import { loadPromptTemplate } from "@jsmart/jsmart-harness";
const template = loadPromptTemplate("/path/to/dir");
// 返回 prompt_template.md 内容，或 null

// 从多个目录按优先级加载
import { loadPromptTemplateFromDirs } from "@jsmart/jsmart-harness";
const template = loadPromptTemplateFromDirs([
    "/project/.jsmart",      // 优先
    "~/.jsmart-coding",      // 回退
]);
```

### 构建提示词

```typescript
import { buildSystemPrompt } from "@jsmart/jsmart-harness";

const prompt = buildSystemPrompt({
    workspace: "/path/to/workspace",
    skills: loadedSkills,
    template: fileContent,  // 从文件加载的模板
    customContent: "Project rules...",
});
```

## 代码变更

### 修改的文件

| 文件 | 变更说明 |
|------|----------|
| `packages/harness/src/prompts.ts` | 添加 `loadPromptTemplate` 和 `loadPromptTemplateFromDirs` |
| `packages/harness/src/agent-session.ts` | 构造函数增加 `AgentSessionOptions` 参数 |
| `packages/harness/src/index.ts` | 导出新增函数 |
| `packages/gateway/src/agent-factory.ts` | 从工作目录加载模板 |
| `packages/coding-agent/src/coding-session.ts` | 从项目/全局目录加载模板 |

### 删除的文件

| 文件 | 说明 |
|------|------|
| `packages/gateway/src/prompts.ts` | 模板改为文件加载 |
| `packages/coding-agent/src/prompts.ts` | 模板改为文件加载 |

## 优势

1. **配置即文件**：模板是普通的 markdown 文件，易于编辑和版本控制
2. **项目隔离**：每个项目可以有独立的提示词模板
3. **全局回退**：coding-agent 支持全局默认模板
4. **简洁**：角色定义直接写在模板中，减少抽象层
