import { loadSkillsFromDir, type Skill } from "./skills.js";

export interface ResourceLoader {
	getSkills(): Skill[];
}

export interface DefaultResourceLoaderOptions {
	// agentDir?: string;
	skillPaths?: string[];
	noSkills?: boolean;
}

export class DefaultResourceLoader implements ResourceLoader {
	// private agentDir?: string;
	private skillPaths?: string[];

	constructor(options: DefaultResourceLoaderOptions) {
		// this.agentDir = options.agentDir;
		if (!options.noSkills) {
			this.skillPaths = options.skillPaths;
		}
	}

	getSkills(): Skill[] {
		// 判断 skillPaths 是否存在
		if (!this.skillPaths?.length) {
			return [];
		}
		let skills: Skill[] = [];
		for (const skillPath of this.skillPaths) {
			const { skills: skillsItem } = loadSkillsFromDir({ dir: skillPath, source: "default" });
			skills = [...skillsItem, ...skills];
		}
		return skills;
	}
}
