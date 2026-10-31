/**
 * Remind the agent when a diagnostic command reports problems.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };

export default function (pi: ExtensionAPI) {
	let diagnosticCommand = "";

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash" || !event.isError) return;

		const command = String((event.input as any)?.command ?? "");
		if (/\b(tsc|eslint|biome|ruff|mypy|pytest|vitest|jest|npm test|pnpm test|cargo test|go test|dotnet test)\b/i.test(command)) {
			diagnosticCommand = command;
		}
	});

	return {
		on: "tool_execution_end",
		when: () => diagnosticCommand !== "",
		message: () => {
			const command = diagnosticCommand;
			diagnosticCommand = "";
			return `New diagnostics or test failures were detected from \`${command}\`. Inspect and address them before claiming the work is complete.`;
		},
		cooldown: 3,
	};
}
