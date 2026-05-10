import type { AgentTool } from "@jsmart/jsmart-agent-core";
import type { Skill } from "./skills.js";

export interface BuildSystemPromptOptions {
	/** Working directory. */
	workspace: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: AgentTool<any>[];
	/** Pre-loaded skills. */
	skills?: Skill[];
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const { workspace: cwd, skills: providedSkills } = options;
	const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const skills = providedSkills ?? [];

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const toolSnippetsList: string[] = [
		"read: read file contents",
		"bash: Execute bash commands (ls, grep, find, etc.)",
		"edit: Make surgical edits to files (find exact text and replace)",
		"write: Create or overwrite files",
	];
	const toolsList = toolSnippetsList.map((s) => `- ${s}`).join("\n");

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [
		"Use bash for file operations like ls, rg, find",
		"Use read to examine files before editing. You must use this tool instead of cat or sed.",
		"Use edit for precise changes (old text must match exactly)",
		"Use write only for new files or complete rewrites",
		"When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did",
		"Be concise in your responses",
		"Show file paths clearly when working with files",
	];
	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	// Append skills section (only if read tool is available)
	const skillsGuidelines = formatSkillsForPrompt(skills);

	const prompt = `
You are an expert personal assistant operating inside pi, a personal assistant agent harness. You help users by reading documents, performing information queries, organizing schedules, drafting replies, managing tasks, taking notes, setting reminders, and creating or editing various types of text content.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

${skillsGuidelines}

Current date: ${date}
Current working directory: ${promptCwd}
`;

	return prompt;
}

export function formatSkillsForPrompt(skills: Skill[]): string {
	const visibleSkills = skills;

	if (visibleSkills.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

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
