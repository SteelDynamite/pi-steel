/**
 * Remind the agent to report failed or skipped verification honestly.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };

export default function (pi: ExtensionAPI) {
	let hadFailure = false;
	let failedTool = "";

	pi.on("tool_result", async (event) => {
		if (event.isError) {
			hadFailure = true;
			failedTool = event.toolName;
		}
	});

	return {
		on: "agent_end",
		when: () => hadFailure,
		message: () => {
			hadFailure = false;
			return `A ${failedTool} call failed during this task. Report the failure or any skipped verification plainly; do not imply everything passed unless it was actually verified.`;
		},
	};
}
