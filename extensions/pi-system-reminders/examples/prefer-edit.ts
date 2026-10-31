/**
 * Remind the agent to use edit instead of write for existing files.
 * Counts writes per agent round and fires at most once per round.
 * Uses per-runtime closure state; not branch-aware after /tree, /fork, /clone, or /resume.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };

export default function (pi: ExtensionAPI) {
	let writeCount = 0;
	let firedThisRound = false;

	pi.on("agent_start", async () => {
		writeCount = 0;
		firedThisRound = false;
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName === "write") writeCount++;
	});

	return {
		on: "tool_execution_end",
		when: () => {
			if (writeCount < 3 || firedThisRound) return false;
			firedThisRound = true;
			return true;
		},
		message: "You've used write 3+ times this round. Prefer edit for surgical changes to existing files.",
	};
}
