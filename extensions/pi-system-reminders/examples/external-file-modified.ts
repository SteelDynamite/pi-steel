/**
 * Remind the agent when a file changed on disk after it was read.
 */
import * as fs from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Lexical identity only: symlink aliases and host read-name fallbacks are not resolved.
function fileKey(value: unknown, cwd: string): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	return resolve(cwd, value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value);
}

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

	// Inspect before mutation; a changed timestamp after our edit is expected.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const filePath = fileKey((event.input as any)?.path, ctx.cwd);
		if (!filePath) return;
		const previous = readMtimes.get(filePath);
		const current = mtimeMs(filePath);
		if (previous !== undefined && current !== undefined && current !== previous) {
			externallyChangedFile = filePath;
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const filePath = fileKey((event.input as any)?.path, ctx.cwd);
		if (!filePath || event.isError) return;

		if (event.toolName === "read") {
			const mtime = mtimeMs(filePath);
			if (mtime !== undefined) readMtimes.set(filePath, mtime);
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			const current = mtimeMs(filePath);
			if (current !== undefined) readMtimes.set(filePath, current);
		}
	});

	return {
		on: "tool_execution_end",
		when: () => externallyChangedFile !== "",
		message: () => {
			const filePath = externallyChangedFile;
			externallyChangedFile = "";
			return `${filePath} changed on disk between the recorded read and a mutation request. Recheck its contents before further edits. This timestamp check cannot identify who changed it or exclude concurrent tool mutations.`;
		},
	};
}
