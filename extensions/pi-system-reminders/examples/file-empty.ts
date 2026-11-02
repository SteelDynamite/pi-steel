/**
 * Warn when a read returns only blank text, without inferring whole-file contents.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };

export default function (pi: ExtensionAPI) {
	let emptyFileDetected = false;
	let emptyFileName = "";

	pi.on("tool_result", async (event) => {
		if (event.toolName === "read" && !event.isError) {
			const content = event.content;
			if (!Array.isArray(content) || content.length === 0 ||
				content.some((c: any) => c.type !== "text" || typeof c.text !== "string")) return;
			const text = content.map((c: any) => c.text).join("");
			if (text.trim() === "") {
				emptyFileDetected = true;
				emptyFileName = (event.input as any)?.path || "unknown";
			}
		}
	});

	return {
		on: "tool_execution_end",
		when: () => {
			if (emptyFileDetected) {
				emptyFileDetected = false;
				return true;
			}
			return false;
		},
		triggerTurn: false,
		message: () => `The returned read range for ${emptyFileName} contains only blank text. This does not establish that the whole file is empty.`,
	};
}
