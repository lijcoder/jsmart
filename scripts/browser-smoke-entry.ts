import { complete, getModel } from "@jsmart/jsmart-ai";

const model = getModel("google", "gemini-2.5-flash");
console.log(model.id, typeof complete);
