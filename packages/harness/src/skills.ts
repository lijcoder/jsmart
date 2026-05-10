import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import { parse } from "yaml";

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

interface SkillFrontmatter {
	name?: string;
	description?: string;
	[key: string]: unknown;
}

export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir } = options;
	return loadSkillsFromDirInternal(dir);
}

function loadSkillsFromDirInternal(dir: string): LoadSkillsResult {
	if (!existsSync(dir)) {
		return { skills: [] };
	}

	const skills: Skill[] = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		// 查找 SKILL.md 文件并解析
		for (const entry of entries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}
			if (!isFile) {
				return { skills: [] };
			}

			const result = loadSkillFromFile(fullPath);
			if (result.skill) {
				return { skills: [result.skill] };
			} else {
				return { skills: [] };
			}
		}

		// 递归解析目录
		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}

			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a directory and follow them
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			if (isDirectory) {
				const subResult = loadSkillsFromDirInternal(fullPath);
				skills.push(...subResult.skills);
			}
		}
	} catch {}

	return { skills };
}

function loadSkillFromFile(filePath: string): { skill: Skill | null } {
	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
		const skillDir = dirname(filePath);
		const parentDirName = basename(skillDir);

		// Use name from frontmatter, or fall back to parent directory name
		const name = frontmatter.name || parentDirName;

		// Still load the skill even with warnings (unless description is completely missing)
		if (!frontmatter.description || frontmatter.description.trim() === "") {
			return { skill: null };
		}

		return {
			skill: {
				name,
				description: frontmatter.description,
				filePath,
				baseDir: skillDir,
			},
		};
	} catch (_error) {
		return { skill: null };
	}
}

// yaml frontmatter

type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yamlString, body } = extractFrontmatter(content);
	if (!yamlString) {
		return { frontmatter: {} as T, body };
	}
	const parsed = parse(yamlString);
	return { frontmatter: (parsed ?? {}) as T, body };
};

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	const normalized = normalizeNewlines(content);

	if (!normalized.startsWith("---")) {
		return { yamlString: null, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { yamlString: null, body: normalized };
	}

	return {
		yamlString: normalized.slice(4, endIndex),
		body: normalized.slice(endIndex + 4).trim(),
	};
};
