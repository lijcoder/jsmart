import type { AgentTool } from "@jsmart/jsmart-agent-core";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { Skill } from "./skills.js";

/**
 * 系统提示词模板中的占位符变量。
 * 模板中使用 {{variable}} 格式，harness 会自动替换。
 * 如果模板中没有某个占位符，则不会生成对应内容。
 */
export type PromptVariable =
	| "tools" // 可用工具列表
	| "skills" // 技能列表
	| "date" // 当前日期
	| "cwd" // 当前工作目录
	| "custom"; // 自定义内容（由应用层传入）

export interface BuildSystemPromptOptions {
	/** Working directory. */
	workspace: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: AgentTool<any>[];
	/** Pre-loaded skills. */
	skills?: Skill[];
	/**
	 * 自定义提示词模板。
	 * 使用 {{variable}} 占位符，支持的变量见 PromptVariable。
	 * 如果未提供，使用内置默认模板。
	 * 模板中没有的占位符不会被替换（对应内容不会出现在最终提示词中）。
	 */
	template?: string;
	/**
	 * 自定义内容，会替换模板中的 {{custom}} 占位符。
	 * 可以是字符串，也可以是返回字符串的函数（支持动态生成）。
	 */
	customContent?: string | (() => string);
}

/** 默认提示词模板 */
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `You are an expert personal assistant operating inside jsmart, a personal assistant agent harness. You help users by reading documents, performing information queries, organizing schedules, drafting replies, managing tasks, taking notes, setting reminders, and creating or editing various types of text content.

Available tools:
{{tools}}

{{skills}}

Current date: {{date}}
Current working directory: {{cwd}}
`;

/**
 * 构建系统提示词。
 * 支持自定义模板，使用 {{variable}} 占位符。
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const { workspace: cwd, skills: providedSkills, template, customContent } = options;
	const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);
	const skills = providedSkills ?? [];

	// 选择模板
	const promptTemplate = template ?? DEFAULT_SYSTEM_PROMPT_TEMPLATE;

	// 构建各部分内容
	const sections: Record<PromptVariable, string> = {
		tools: buildToolsSection(options.selectedTools),
		skills: formatSkillsForPrompt(skills),
		date: date,
		cwd: promptCwd,
		custom: resolveCustomContent(customContent),
	};

	// 替换占位符（只替换模板中存在的）
	return replacePlaceholders(promptTemplate, sections);
}

/**
 * 构建工具列表部分。
 * 根据传入的工具数组动态生成，使用工具的 name 和 description。
 */
function buildToolsSection(selectedTools?: AgentTool<any>[]): string {
	if (!selectedTools || selectedTools.length === 0) {
		return "No tools available.";
	}

	return selectedTools
		.map((tool) => {
			const desc = tool.description || "";
			return desc ? `- ${tool.name}: ${desc}` : `- ${tool.name}`;
		})
		.join("\n");
}

/**
 * 解析自定义内容
 */
function resolveCustomContent(customContent?: string | (() => string)): string {
	if (!customContent) return "";
	return typeof customContent === "function" ? customContent() : customContent;
}

/**
 * 替换模板中的占位符。
 * 支持条件语法：
 * - {{#if variable}}...{{/if}} - 变量有值时显示
 * - {{#unless variable}}...{{/unless}} - 变量无值时显示
 * - {{#if variable}}...{{else}}...{{/if}} - 支持 else 分支
 *
 * 只替换模板中实际存在的占位符，没有的不会添加。
 */
function replacePlaceholders(template: string, sections: Record<PromptVariable, string>): string {
	let result = template;

	// 1. 先处理条件块
	result = processConditionals(result, sections);

	// 2. 再替换普通占位符
	for (const [key, value] of Object.entries(sections) as [PromptVariable, string][]) {
		const placeholder = `{{${key}}}`;
		// 只替换模板中存在的占位符
		if (result.includes(placeholder)) {
			result = result.replaceAll(placeholder, value);
		}
	}

	// 3. 清理多余的空行（连续的空行合并为一个）
	result = result.replace(/\n{3,}/g, "\n\n").trim();

	return result;
}

/**
 * 处理模板中的条件块。
 * 支持 {{#if var}}...{{/if}}、{{#unless var}}...{{/unless}}、{{else}}
 */
function processConditionals(template: string, sections: Record<PromptVariable, string>): string {
	let result = template;

	// 处理 {{#if variable}}...{{else}}...{{/if}} 和 {{#if variable}}...{{/if}}
	result = result.replace(
		/\{\{#if\s+(\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
		(_match, variable, ifContent, elseContent) => {
			const value = sections[variable as PromptVariable];
			const hasValue = value !== undefined && value !== "";
			return hasValue ? ifContent : (elseContent ?? "");
		},
	);

	// 处理 {{#unless variable}}...{{/unless}}
	result = result.replace(/\{\{#unless\s+(\w+)\}\}([\s\S]*?)\{\{\/unless\}\}/g, (_match, variable, content) => {
		const value = sections[variable as PromptVariable];
		const hasValue = value !== undefined && value !== "";
		return hasValue ? "" : content;
	});

	return result;
}

/**
 * 格式化技能列表为提示词内容。
 * 如果没有技能，返回空字符串。
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
	const visibleSkills = skills;

	if (visibleSkills.length === 0) {
		return "";
	}

	const lines = ["<available_skills>"];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * 从文件系统加载提示词模板。
 * @param dir - 模板所在目录
 * @returns 模板内容，如果文件不存在则返回 null
 */
export function loadPromptTemplate(dir: string): string | null {
	const templatePath = resolve(dir, "prompt_template.md");
	if (!existsSync(templatePath)) {
		return null;
	}
	return readFileSync(templatePath, "utf-8");
}

/**
 * 从多个目录中按优先级加载提示词模板。
 * 返回第一个找到的模板，如果都没找到则返回 null。
 * @param dirs - 目录列表，按优先级排序
 */
export function loadPromptTemplateFromDirs(dirs: string[]): string | null {
	for (const dir of dirs) {
		const template = loadPromptTemplate(dir);
		if (template !== null) {
			return template;
		}
	}
	return null;
}
