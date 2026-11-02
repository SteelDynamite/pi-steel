/**
 * Remind the agent when it keeps editing the same file repeatedly.
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
	const editCounts = new Map<string, number>();

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "edit" && !event.isError) {
			const filePath = fileKey((event.input as any)?.path, ctx.cwd);
			if (filePath) {
				editCounts.set(filePath, (editCounts.get(filePath) ?? 0) + 1);
			}
		}
	});

	return {
		on: "tool_execution_end",
		when: () => {
			for (const [, count] of editCounts) {
				if (count >= 5) return true;
			}
			return false;
		},
		message: () => {
			const worst = [...editCounts.entries()].sort((a, b) => b[1] - a[1])[0];
			return `You've edited ${worst[0]} ${worst[1]} times. Step back and consider a different approach.`;
		},
		cooldown: 10,
	};
}
