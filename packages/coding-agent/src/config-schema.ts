import { AgentSettingsSchema } from "@jsmart/jsmart-harness";
import AjvModule from "ajv";

const Ajv = (AjvModule as any).default || AjvModule;
export const ajv = new Ajv();

export const CodingSettingsSchema = AgentSettingsSchema;

ajv.addSchema(CodingSettingsSchema, "CodingSettings");

export type { AgentSettings as CodingSettings, ModelSettings } from "@jsmart/jsmart-harness";
