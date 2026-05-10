import { ModelManager } from "../src/model-manager.js";

const modelJsonPath: string = "/Users/lijie/.jie/test/models.json";
const modelManager = ModelManager.create(modelJsonPath);
console.log(`modelManager.getAll.length: ${modelManager.getAll().length}`);
