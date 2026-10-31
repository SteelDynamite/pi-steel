/**
 * Remind the agent to use task tracking tools if they haven't been used recently.
 * Uses per-runtime closure state; not branch-aware after /tree, /fork, /clone, or /resume.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };

export default function (pi: ExtensionAPI) {
	let toolCallsSinceLastTask = 0;

	const taskToolNames = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskExecute"]);

	pi.on("tool_result", async (event) => {
		if (taskToolNames.has(event.toolName)) {
			toolCallsSinceLastTask = 0;
		} else {
			toolCallsSinceLastTask++;
		}
	});

	return {
		on: "turn_end",
		when: () => toolCallsSinceLastTask >= 20,
		triggerTurn: false,
		message: "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status. Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.",
		cooldown: 20,
	};
}
