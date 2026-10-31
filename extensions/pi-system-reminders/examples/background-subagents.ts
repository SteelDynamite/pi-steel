/**
 * After spawning background subagents, remind the main agent not to duplicate their work.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };

export default function (pi: ExtensionAPI) {
	let backgroundSubagentSpawned = false;

	pi.on("tool_result", async (event) => {
		if (
			event.toolName === "Agent" &&
			!event.isError &&
			(event.input as any)?.run_in_background === true
		) {
			backgroundSubagentSpawned = true;
		}
	});

	return {
		on: "tool_execution_end",
		when: () => {
			if (!backgroundSubagentSpawned) return false;
			backgroundSubagentSpawned = false;
			return true;
		},
		message: "You just spawned one or more background subagents. Avoid duplicating their work in the main agent. Continue only on coordination, unrelated work, or tasks that unblock the subagents. Wait for their completion notification or use get_subagent_result before repeating their searches or implementation work.",
	};
}
