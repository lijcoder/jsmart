import { type Static, Type } from "@sinclair/typebox";
import AjvModule from "ajv";

const Ajv = (AjvModule as any).default || AjvModule;
export const ajv = new Ajv();

/** Reference to a model (provider + model id) */
export const ModelRefSchema = Type.Object({
	provider: Type.String({ minLength: 1 }),
	model: Type.String({ minLength: 1 }),
});

/** Coding agent settings */
export const CodingSettingsSchema = Type.Object({
	defaultModel: Type.Optional(ModelRefSchema),
	skillPaths: Type.Optional(Type.Array(Type.String())),
});

ajv.addSchema(CodingSettingsSchema, "CodingSettings");

export type ModelRef = Static<typeof ModelRefSchema>;
export type CodingSettings = Static<typeof CodingSettingsSchema>;
