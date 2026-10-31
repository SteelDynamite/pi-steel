/**
 * After compaction, remind the agent that file contents may have been summarized away.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };

export default function (_pi: ExtensionAPI) {
	return {
		on: "session_compact",
		when: () => true,
		triggerTurn: false,
		message: "Conversation was just compacted. Previously read file contents may have been summarized away. Use the read tool to re-read any files you need to reference.",
		once: true,
	};
}
