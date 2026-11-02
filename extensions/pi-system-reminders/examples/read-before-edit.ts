/**
 * Remind the agent to read a file before editing it.
 * Uses per-runtime closure state; not branch-aware after /tree, /fork, /clone, or /resume.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

// Lexical identity only: symlink aliases and host read-name fallbacks are not resolved.
function fileKey(value: unknown, cwd: string): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	return resolve(cwd, value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value);
}

type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };

export default function (pi: ExtensionAPI) {
	const readFiles = new Set<string>();
	let editedUnread = false;
	let lastUnreadFile = "";

	pi.on("tool_result", async (event, ctx) => {
		const filePath = fileKey((event.input as any)?.path, ctx.cwd);
		if (event.toolName === "read" && !event.isError && filePath) {
			readFiles.add(filePath);
		}
		if (event.toolName === "edit" && !event.isError) {
			if (filePath && !readFiles.has(filePath)) {
				editedUnread = true;
				lastUnreadFile = filePath;
			}
		}
	});

	return {
		on: "tool_execution_end",
		when: () => {
			if (editedUnread) {
				editedUnread = false;
				return true;
			}
			return false;
		},
		message: () => `You edited ${lastUnreadFile} without reading it first. Always read files before editing to avoid stale oldText.`,
	};
}
