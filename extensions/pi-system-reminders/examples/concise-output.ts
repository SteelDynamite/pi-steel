/**
 * Remind the agent to keep responses short and concise.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };

export default function (_pi: ExtensionAPI) {
	return {
		on: "agent_start",
		when: () => true,
		triggerTurn: false,
		message: "Use as few words as possible to say what you want to say. Use only the detail needed to answer the user.",
		cooldown: 3,
	};
}
