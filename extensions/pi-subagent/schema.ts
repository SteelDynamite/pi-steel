import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const SessionIntentSchema = StringEnum(["new", "resume"] as const, {
	description: 'Required session intent. Use "new" for first/fresh calls and "resume" only when the previous result said so.',
});

export const SubagentParams = Type.Object({
	id: Type.String({ description: "Behavioral or locational agent id to invoke" }),
	session: SessionIntentSchema,
	task: Type.String({ description: "Task to delegate to the agent" }),
	contextDocs: Type.Optional(Type.Array(Type.String({ description: "Required document path the child must read before starting" }))),
	includeLocationalAgents: Type.Optional(
		Type.Boolean({ description: "Allow a behavioral child to discover locational agents. Default: false.", default: false }),
	),
}, { additionalProperties: false });
