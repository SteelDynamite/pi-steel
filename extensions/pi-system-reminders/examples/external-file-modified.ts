/**
 * Remind the agent when a file changed on disk after it was read.
 */
import * as fs from "node:fs";
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };

function mtimeMs(filePath: string): number | undefined {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const readMtimes = new Map<string, number>();
	let externallyChangedFile = "";

	pi.on("tool_result", async (event) => {
		const filePath = String((event.input as any)?.path ?? "");
		if (!filePath || event.isError) return;

		if (event.toolName === "read") {
			const mtime = mtimeMs(filePath);
			if (mtime !== undefined) readMtimes.set(filePath, mtime);
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			const previous = readMtimes.get(filePath);
			const current = mtimeMs(filePath);
			if (previous !== undefined && current !== undefined && current !== previous) {
				externallyChangedFile = filePath;
			}
			if (current !== undefined) readMtimes.set(filePath, current);
		}
	});

	return {
		on: "tool_execution_end",
		when: () => externallyChangedFile !== "",
		message: () => {
			const filePath = externallyChangedFile;
			externallyChangedFile = "";
			return `${filePath} changed on disk after you read it. Treat that change as intentional user/linter input: account for it and do not revert it unless the user asks.`;
		},
	};
}
