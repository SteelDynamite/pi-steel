/**
 * Warn when a failed bash command's output was truncated.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };

function textContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && "text" in part ? String((part as any).text ?? "") : ""))
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	let truncatedFailure = false;
	let fullOutputPath = "";

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash" || !event.isError) return;

		const details = (event as any).details;
		const output = textContent((event as any).content);
		const match = output.match(/Full output:\s*([^\]\n]+)/i);

		if (details?.truncation?.truncated || match) {
			truncatedFailure = true;
			fullOutputPath = String(details?.fullOutputPath ?? match?.[1] ?? "").trim();
		}
	});

	return {
		on: "tool_execution_end",
		when: () => {
			if (truncatedFailure) {
				truncatedFailure = false;
				return true;
			}
			return false;
		},
		message: () => {
			const suffix = fullOutputPath ? ` Full output: ${fullOutputPath}` : "";
			fullOutputPath = "";
			return `Bash output was truncated and the command failed. Do not assume the visible tail contains the root cause; inspect the full output if earlier output may matter.${suffix}`;
		},
		cooldown: 3,
	};
}
