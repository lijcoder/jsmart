import { loadSkillsFromDir } from "../src/skills.js";

const dir = "/Users/lijie/.jie/test/skills";

const { skills } = loadSkillsFromDir({ dir: dir, source: "test" });
console.log(skills);
