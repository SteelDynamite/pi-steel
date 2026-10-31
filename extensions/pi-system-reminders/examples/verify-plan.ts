/**
 * Remind the agent to verify completed plan/task work directly.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };

export default function (pi: ExtensionAPI) {
	let completedTasksSinceVerification = 0;

	pi.on("tool_result", async (event) => {
		if (event.toolName === "TaskUpdate" && !event.isError) {
			const status = (event.input as any)?.status;
			if (status === "completed") completedTasksSinceVerification++;
		}

		if (event.toolName === "bash" && !event.isError) {
			const command = String((event.input as any)?.command ?? "");
			if (/\b(test|typecheck|lint|check|verify|tsc|vitest|jest|pytest)\b/i.test(command)) {
				completedTasksSinceVerification = 0;
			}
		}
	});

	return {
		on: "agent_end",
		when: () => completedTasksSinceVerification > 0,
		message: "You marked task work complete. If you have not already done so, verify the completed plan directly with the relevant tests, typecheck, lint, build, or inspection. Do not delegate final verification to another agent.",
		cooldown: 1,
	};
}
