import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	buildSystemPrompt,
	DEFAULT_SYSTEM_PROMPT_TEMPLATE,
	loadPromptTemplate,
	loadPromptTemplateFromDirs,
} from "../src/prompts.js";
import type { Skill } from "../src/skills.js";

describe("buildSystemPrompt", () => {
	const mockSkills: Skill[] = [
		{
			name: "test-skill",
			description: "A test skill",
			filePath: "/test/skills/test-skill/SKILL.md",
			baseDir: "/test/skills/test-skill",
		},
	];

	it("should use default template when no template provided", () => {
		const mockTools: any[] = [
			{ name: "read", description: "Read file contents" },
			{ name: "bash", description: "Execute bash commands" },
			{ name: "edit", description: "Make surgical edits" },
			{ name: "write", description: "Create or overwrite files" },
		];

		const prompt = buildSystemPrompt({
			workspace: "/test/workspace",
			skills: mockSkills,
			selectedTools: mockTools,
		});

		expect(prompt).toContain("You are an expert personal assistant");
		expect(prompt).toContain("- read: Read file contents");
		expect(prompt).toContain("- bash: Execute bash commands");
		expect(prompt).toContain("Current date:");
		expect(prompt).toContain("Current working directory: /test/workspace");
		expect(prompt).toContain("<available_skills>");
		expect(prompt).not.toContain("{{");
	});

	it("should replace only existing placeholders", () => {
		const template = `My custom role definition.

Tools: 
{{tools}}

Date: {{date}}`;

		const mockTools: any[] = [{ name: "read", description: "Read file contents" }];

		const prompt = buildSystemPrompt({
			workspace: "/test",
			template,
			selectedTools: mockTools,
		});

		expect(prompt).toContain("My custom role definition.");
		expect(prompt).toContain("- read: Read file contents");
		expect(prompt).toContain("Date: 20");
		expect(prompt).not.toContain("{{skills}}");
		expect(prompt).not.toContain("{{cwd}}");
	});

	it("should handle customContent as string", () => {
		const template = `Role here.

{{custom}}`;

		const prompt = buildSystemPrompt({
			workspace: "/test",
			template,
			customContent: "My custom instructions",
		});

		expect(prompt).toContain("My custom instructions");
		expect(prompt).not.toContain("{{custom}}");
	});

	it("should handle customContent as function", () => {
		const template = `Role here.

{{custom}}`;

		const prompt = buildSystemPrompt({
			workspace: "/test",
			template,
			customContent: () => "Dynamic content",
		});

		expect(prompt).toContain("Dynamic content");
	});

	it("should clean up extra blank lines", () => {
		const template = `Role here.


{{tools}}


{{date}}`;

		const prompt = buildSystemPrompt({
			workspace: "/test",
			template,
		});

		// Should not have more than 2 consecutive newlines
		expect(prompt).not.toMatch(/\n{3,}/);
	});

	it("should escape XML in skills", () => {
		const skillsWithSpecialChars: Skill[] = [
			{
				name: 'skill <test> & "quotes"',
				description: "Description with <special> chars",
				filePath: "/test/path",
				baseDir: "/test",
			},
		];

		const prompt = buildSystemPrompt({
			workspace: "/test",
			skills: skillsWithSpecialChars,
		});

		expect(prompt).toContain("&lt;test&gt;");
		expect(prompt).toContain("&amp;");
		expect(prompt).toContain("&quot;quotes&quot;");
	});

	it("should handle {{#if skills}} block when skills exist", () => {
		const template = `Role here.

{{#if skills}}
## Available Skills
{{skills}}
{{/if}}

Date: {{date}}`;

		const prompt = buildSystemPrompt({
			workspace: "/test",
			skills: mockSkills,
			template,
		});

		expect(prompt).toContain("## Available Skills");
		expect(prompt).toContain("<available_skills>");
		expect(prompt).not.toContain("{{#if");
	});

	it("should hide {{#if skills}} block when no skills", () => {
		const template = `Role here.

{{#if skills}}
## Available Skills
{{skills}}
{{/if}}

Date: {{date}}`;

		const prompt = buildSystemPrompt({
			workspace: "/test",
			template,
		});

		expect(prompt).not.toContain("## Available Skills");
		expect(prompt).not.toContain("<available_skills>");
		expect(prompt).toContain("Date:");
	});

	it("should handle {{#unless skills}} block", () => {
		const template = `Role here.

{{#unless skills}}
No skills loaded. You can use general tools to help the user.
{{/unless}}

Date: {{date}}`;

		const prompt = buildSystemPrompt({
			workspace: "/test",
			template,
		});

		expect(prompt).toContain("No skills loaded");
		expect(prompt).not.toContain("{{#unless");
	});

	it("should hide {{#unless skills}} block when skills exist", () => {
		const template = `Role here.

{{#unless skills}}
No skills loaded.
{{/unless}}

Date: {{date}}`;

		const prompt = buildSystemPrompt({
			workspace: "/test",
			skills: mockSkills,
			template,
		});

		expect(prompt).not.toContain("No skills loaded");
		expect(prompt).toContain("Date:");
	});

	it("should handle {{#if}}...{{#else}}...{{/if}}", () => {
		const template = `Role here.

{{#if skills}}
## Skills Available
{{skills}}
{{#else}}
## No Skills
Use your general knowledge to help.
{{/if}}

Date: {{date}}`;

		// With skills
		const promptWith = buildSystemPrompt({
			workspace: "/test",
			skills: mockSkills,
			template,
		});
		expect(promptWith).toContain("## Skills Available");
		expect(promptWith).not.toContain("## No Skills");

		// Without skills
		const promptWithout = buildSystemPrompt({
			workspace: "/test",
			template,
		});
		expect(promptWithout).toContain("## No Skills");
		expect(promptWithout).toContain("Use your general knowledge");
		expect(promptWithout).not.toContain("## Skills Available");
	});

	it("should handle nested conditionals", () => {
		const template = `Role here.

{{#if skills}}
## Skills
{{skills}}
{{#if custom}}
## Custom Rules
{{custom}}
{{/if}}
{{/if}}

Date: {{date}}`;

		const prompt = buildSystemPrompt({
			workspace: "/test",
			skills: mockSkills,
			customContent: "Custom rule here",
			template,
		});

		expect(prompt).toContain("## Skills");
		expect(prompt).toContain("## Custom Rules");
		expect(prompt).toContain("Custom rule here");
	});
});

describe("DEFAULT_SYSTEM_PROMPT_TEMPLATE", () => {
	it("should contain all placeholders", () => {
		expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain("{{tools}}");
		expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain("{{skills}}");
		expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain("{{date}}");
		expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain("{{cwd}}");
		// Role is now hardcoded in the template, not a placeholder
		expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain("You are an expert personal assistant");
	});
});

describe("buildToolsSection", () => {
	it("should dynamically build tools from selectedTools", () => {
		const mockTools: any[] = [
			{ name: "read", description: "Read file contents" },
			{ name: "bash", description: "Execute bash commands" },
		];

		const prompt = buildSystemPrompt({
			workspace: "/test",
			selectedTools: mockTools,
		});

		expect(prompt).toContain("- read: Read file contents");
		expect(prompt).toContain("- bash: Execute bash commands");
	});

	it("should use name when description is empty", () => {
		const mockTools: any[] = [{ name: "custom", description: "" }];

		const prompt = buildSystemPrompt({
			workspace: "/test",
			selectedTools: mockTools,
		});

		expect(prompt).toContain("- custom");
	});

	it("should show 'No tools available' when no tools provided", () => {
		const prompt = buildSystemPrompt({
			workspace: "/test",
			selectedTools: [],
		});

		expect(prompt).toContain("No tools available.");
	});
});

describe("loadPromptTemplate", () => {
	it("should load template from directory", () => {
		const testDir = join(tmpdir(), `jsmart-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		writeFileSync(join(testDir, "prompt_template.md"), "Custom template {{tools}}");

		try {
			const template = loadPromptTemplate(testDir);
			expect(template).toBe("Custom template {{tools}}");
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should return null when template file does not exist", () => {
		const testDir = join(tmpdir(), `jsmart-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		try {
			const template = loadPromptTemplate(testDir);
			expect(template).toBeNull();
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});

describe("loadPromptTemplateFromDirs", () => {
	it("should load from first directory that has template", () => {
		const dir1 = join(tmpdir(), `jsmart-test-${Date.now()}-1`);
		const dir2 = join(tmpdir(), `jsmart-test-${Date.now()}-2`);
		mkdirSync(dir1, { recursive: true });
		mkdirSync(dir2, { recursive: true });
		writeFileSync(join(dir2, "prompt_template.md"), "Template from dir2");

		try {
			// dir1 has no template, should fall back to dir2
			const template = loadPromptTemplateFromDirs([dir1, dir2]);
			expect(template).toBe("Template from dir2");
		} finally {
			rmSync(dir1, { recursive: true, force: true });
			rmSync(dir2, { recursive: true, force: true });
		}
	});

	it("should prefer first directory when both have templates", () => {
		const dir1 = join(tmpdir(), `jsmart-test-${Date.now()}-1`);
		const dir2 = join(tmpdir(), `jsmart-test-${Date.now()}-2`);
		mkdirSync(dir1, { recursive: true });
		mkdirSync(dir2, { recursive: true });
		writeFileSync(join(dir1, "prompt_template.md"), "Template from dir1");
		writeFileSync(join(dir2, "prompt_template.md"), "Template from dir2");

		try {
			const template = loadPromptTemplateFromDirs([dir1, dir2]);
			expect(template).toBe("Template from dir1");
		} finally {
			rmSync(dir1, { recursive: true, force: true });
			rmSync(dir2, { recursive: true, force: true });
		}
	});

	it("should return null when no directories have template", () => {
		const dir1 = join(tmpdir(), `jsmart-test-${Date.now()}-1`);
		const dir2 = join(tmpdir(), `jsmart-test-${Date.now()}-2`);
		mkdirSync(dir1, { recursive: true });
		mkdirSync(dir2, { recursive: true });

		try {
			const template = loadPromptTemplateFromDirs([dir1, dir2]);
			expect(template).toBeNull();
		} finally {
			rmSync(dir1, { recursive: true, force: true });
			rmSync(dir2, { recursive: true, force: true });
		}
	});
});
