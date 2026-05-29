import { loadSkillsFromDir, type Skill } from "./skills.js";

export interface ResourceLoader {
	getSkills(): Skill[];
}

export interface DefaultResourceLoaderOptions {
	skillPaths?: string[];
	noSkills?: boolean;
}

export class DefaultResourceLoader implements ResourceLoader {
	private skillPaths?: string[];

	constructor(options: DefaultResourceLoaderOptions) {
		if (!options.noSkills) {
			this.skillPaths = options.skillPaths;
		}
	}

	getSkills(): Skill[] {
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
