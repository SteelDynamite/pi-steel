import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { THINKING_LEVELS } from "./agents.ts";

const configurationProperties = {
	model: Type.Optional(Type.String({ pattern: "^[^/\\s,*?\\[\\]]+/[^\\s,*?\\[\\]]+$", description: "One exact provider/model ID; unavailable models fail without fallback. Omit to use the role's effective model, or the caller for an inline agent." })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "One-call thinking level, overriding the role's effective level. Pi clamps to model support." })),
	tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true, description: "Exact known tool names for Pi's child tool selection. [] disables all tools; omission uses role/default tools. Not a security sandbox." })),
};

export const AgentOverridesSchema = Type.Object(configurationProperties, { additionalProperties: false, minProperties: 1, description: "One-off overrides for an existing behavioral role; retains its instructions. Requires session new. Mutually exclusive with custom." });
export const CustomAgentSchema = Type.Object({
	...configurationProperties,
	instructions: Type.String({ minLength: 1, pattern: "\\S", description: "Literal appended system instructions for this inline behavioral agent; no file includes are expanded." }),
}, { additionalProperties: false, description: "One-off inline behavioral agent, without a definition file. Requires session new and an unused id. Mutually exclusive with overrides." });
export type AgentOverrides = Static<typeof AgentOverridesSchema>;
export type CustomAgent = Static<typeof CustomAgentSchema>;

export const SessionIntentSchema = StringEnum(["new", "resume"] as const, {
	description: 'Required session intent. Use "new" for first/fresh calls and "resume" only when the previous result said so.',
});

export const SubagentParams = Type.Object({
	id: Type.String({ description: "Behavioral agent id; with custom, a new lowercase kebab-case label that must not collide with an existing agent. Locational paths require PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS=1 and cannot use one-off configuration." }),
	session: SessionIntentSchema,
	task: Type.String({ description: "Task to delegate to the agent" }),
	overrides: Type.Optional(AgentOverridesSchema),
	custom: Type.Optional(CustomAgentSchema),
	contextDocs: Type.Optional(Type.Array(Type.String({ description: "Required document path the child must read before starting" }))),
	includeLocationalAgents: Type.Optional(
		Type.Boolean({ description: "Allow a behavioral child to discover locational agents only when PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS=1. Cannot enable the feature itself. Default: false.", default: false }),
	),
}, { additionalProperties: false });
