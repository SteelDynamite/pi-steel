import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	discoverAgents,
	getAgentInstructionsFileName,
	isPathInside,
	resolveLocationalAgentId,
} from "./agents.ts";
import { CURRENT_LOCATIONAL_ROOT_ENV, DEFAULT_KNOWN_TOOLS, locationalAgentsEnabled } from "./constants.ts";
import { runDelegation, setKnownToolNames, validateAgentTools } from "./execution.ts";
import {
	appendLocationalManifest,
	makeLocationalManifest,
	registerLocationalManifestRenderer,
	shouldAdvertiseLocationalAgents,
} from "./locational-manifest.ts";
import {
	commandFilesystemTargets,
	canonicalPath,
	containingLocationalRoot,
	resolveBuiltinTarget,
	getGuardedLocationalRoots,
	notifyLocationalBoundaryDiscovered,
	resolveFilesystemTarget,
} from "./locational-guard.ts";
import { addContextDocsToTask, getMissingSessionError } from "./params.ts";
import type { ExtensionAPI, ExtensionContext } from "./pi-compat.ts";
import { formatBehavioralAgentManifest, formatLocalLocationalPrompt } from "./prompt.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { getResultOutput, isFailedResult, makeErrorResult } from "./result.ts";
import { SubagentParams } from "./schema.ts";
import {
	getMainSessionKey,
	persistSubagentState,
	restoreSubagentState,
	subagentSettings,
	trackedSessions,
} from "./state.ts";
import type { OnUpdateCallback, SessionIntent, SingleResult, SubagentDetails } from "./types.ts";

export { getFinalOutput } from "./result.ts";

export type SubagentToolParams = {
	id?: string;
	session?: SessionIntent;
	task?: string;
	contextDocs?: string[];
	includeLocationalAgents?: boolean;
};

export default async function (pi: ExtensionAPI) {
	if (process.env.HC_TERMINAL_ID?.trim()) {
		const skillPath = fileURLToPath(new URL("./skills/herdr-delegation/SKILL.md", import.meta.url));
		let warning = "Herdr detected, but hc --skill is unavailable. Keeping native subagents. Install/update hc (https://herdr.dev/core/), ensure it is on Pi's PATH, then /reload.";
		if (locationalAgentsEnabled()) {
			// An automatic handoff must not silently remove explicitly enabled guards.
			warning = "Herdr detected; keeping native subagents because PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS=1 enables locational guards.";
		} else if (!existsSync(skillPath)) {
			warning = "Herdr detected, but the bundled herdr-delegation skill is missing. Keeping native subagents. Reinstall/update the package containing pi-subagent, then /reload.";
		} else {
			try {
				// Reading the installed manual neither starts a core nor inspects other terminals.
				// Bound this startup check; no retries or background supervision.
				const result = await pi.exec("hc", ["--skill"], { timeout: 3000, maxBuffer: 256 * 1024 });
				if (result.code === 0 && !result.killed && !result.truncated && result.stdout.includes("herdr-core")) {
					pi.on("resources_discover", () => ({ skillPaths: [skillPath] }));
					return;
				}
			} catch { /* Missing or unusable hc retains the normal delegation path. */ }
		}
		if (process.env.PI_ORCHESTRATED_CHILD !== "1") {
			let warned = false;
			pi.on("session_start", (_event, ctx) => {
				if (warned || !ctx.hasUI) return;
				warned = true;
				ctx.ui.notify(warning, "warning");
			});
		}
	}
	registerLocationalManifestRenderer(pi);
	pi.on("session_start", async (_event, ctx) => {
		restoreSubagentState(ctx);
		appendLocationalManifest(pi, ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		restoreSubagentState(ctx);
		appendLocationalManifest(pi, ctx);
	});
	pi.on("session_compact", async (_event, ctx) => appendLocationalManifest(pi, ctx));

	pi.registerCommand("subagent-settings", {
		description: "Configure subagent session reuse and context threshold",
		handler: async (_args: unknown, ctx: ExtensionContext) => {
			restoreSubagentState(ctx);
			while (true) {
				const sessionKey = getMainSessionKey(ctx);
				const active = [...trackedSessions.values()].filter((record) => record.mainSessionKey === sessionKey);
				const choice = await ctx.ui.select("Pi Subagent settings", [
					`Reuse: ${subagentSettings.reuseEnabled ? "enabled" : "disabled"}`,
					`Context threshold: ${Math.round(subagentSettings.contextThreshold * 100)}%`,
					`Active resumable sessions: ${active.length}`,
					"Reset tracked resumable sessions",
					"Close",
				]);
				if (!choice || choice === "Close") return;
				if (choice.startsWith("Reuse:")) {
					subagentSettings.reuseEnabled = !subagentSettings.reuseEnabled;
					persistSubagentState(pi);
					ctx.ui.notify(`Subagent reuse ${subagentSettings.reuseEnabled ? "enabled" : "disabled"}.`, "info");
					continue;
				}
				if (choice.startsWith("Context threshold:")) {
					const input = await ctx.ui.input("Context threshold percent", String(Math.round(subagentSettings.contextThreshold * 100)));
					if (!input) continue;
					const percent = Number(input.trim().replace(/%$/, ""));
					if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
						ctx.ui.notify("Threshold must be between 1 and 100.", "error");
						continue;
					}
					subagentSettings.contextThreshold = percent / 100;
					persistSubagentState(pi);
					continue;
				}
				if (choice.startsWith("Active resumable sessions:")) {
					const lines = active.length
						? active.map((record) => `${record.agentId}: next session "${record.nextIntent}"${record.contextWindow ? ` (${record.contextTokens}/${record.contextWindow} tokens)` : ""}`)
						: ["No active resumable sessions."];
					ctx.ui.notify(lines.join("\n"), "info");
					continue;
				}
				const confirmed = await ctx.ui.confirm("Reset subagent sessions?", "Clear tracked resumable subagent sessions for the current main session.");
				if (!confirmed) continue;
				for (const [key, record] of trackedSessions) {
					if (record.mainSessionKey === sessionKey) trackedSessions.delete(key);
				}
				persistSubagentState(pi);
				ctx.ui.notify("Tracked resumable subagent sessions reset.", "info");
			}
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		setKnownToolNames([
			...DEFAULT_KNOWN_TOOLS,
			...Object.keys(event.systemPromptOptions.toolSnippets ?? {}),
			...(event.systemPromptOptions.selectedTools ?? []),
		]);
		const trusted = ctx.isProjectTrusted();
		const advertiseLocational = trusted && shouldAdvertiseLocationalAgents();
		const discovery = discoverAgents(ctx.cwd, trusted, { includeLocationalAgents: advertiseLocational });
		const parts: string[] = [];
		const behavioral = formatBehavioralAgentManifest(discovery.agents);
		if (behavioral) {
			parts.push(`Behavioral subagents can be delegated to with the subagent tool by id and required session intent ("new" or "resume"). Use session: "new" for a first/fresh call; use session: "resume" only when the previous result for that subagent said to. Behavioral agents run from the caller directory.\n\n${behavioral}`);
		}
		const locational = makeLocationalManifest(discovery.locationalAgents);
		if (locational) parts.push(locational.content);
		const activeRoot = process.env[CURRENT_LOCATIONAL_ROOT_ENV];
		if (advertiseLocational && (!activeRoot || path.resolve(activeRoot) !== path.resolve(ctx.cwd))) {
			const local = resolveLocationalAgentId(ctx.cwd, ctx.cwd);
			if (local) {
				parts.push(formatLocalLocationalPrompt(ctx, event.systemPromptOptions, path.join(path.resolve(ctx.cwd), getAgentInstructionsFileName()), local.systemPrompt));
			}
		}
		const errors = [...discovery.errors, ...discovery.agents.map(validateAgentTools).filter((error): error is string => Boolean(error))];
		if (errors.length) parts.push(`Subagent configuration errors:\n${errors.map((error) => `- ${error}`).join("\n")}`);
		return parts.length ? { systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n")}` } : undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "subagent" || !locationalAgentsEnabled() || !ctx.isProjectTrusted()) return;
		const roots = getGuardedLocationalRoots(ctx.cwd);
		const input = (event.input ?? {}) as Record<string, unknown>;
		const candidates: string[] = [];
		for (const key of ["path", "file_path", "filePath", "cwd", "dir", "directory", "root", "rootDir"]) {
			const value = input[key];
			if (typeof value !== "string") continue;
			const target = ["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)
				? resolveBuiltinTarget(ctx.cwd, value, event.toolName === "read")
				: resolveFilesystemTarget(ctx.cwd, value, { allowBare: true });
			if (target) candidates.push(target);
		}
		if (event.toolName === "bash") {
			const bashCwd = typeof input.cwd === "string"
				? resolveFilesystemTarget(ctx.cwd, input.cwd, { allowBare: true }) ?? path.resolve(ctx.cwd, input.cwd)
				: ctx.cwd;
			candidates.push(bashCwd);
			if (typeof input.command === "string") candidates.push(...commandFilesystemTargets(input.command, bashCwd));
		}
		const recursive = event.toolName === "grep" || event.toolName === "find";
		if (recursive && !candidates.length) candidates.push(resolveBuiltinTarget(ctx.cwd, "."));
		for (const candidate of candidates) {
			const containing = containingLocationalRoot(candidate, ctx.cwd);
			const root = roots.find((item) => isPathInside(candidate, item) || (recursive && isPathInside(item, candidate)))
				?? (containing && containing !== (process.env[CURRENT_LOCATIONAL_ROOT_ENV] ? canonicalPath(process.env[CURRENT_LOCATIONAL_ROOT_ENV]!) : undefined) ? containing : undefined);
			if (!root) continue;
			notifyLocationalBoundaryDiscovered(ctx, root);
			return { block: true, reason: `Locational boundary enforced: delegate with subagent using locational agent id "${root}" instead of accessing it directly.` };
		}
	});

	pi.registerTool({
		name: "subagent",
		// Standalone tool rendering and progress require direct model calls in every mode.
		exposure: "model-only",
		label: "Subagent",
		description: locationalAgentsEnabled()
			? "Delegate exactly one task to an isolated behavioral or locational Pi agent and wait for its result. Requires id, session, and task. Behavioral agents inherit the caller directory. Locational agents use a caller-relative or absolute source-root id containing SUBAGENTS.md and run from that root. Behavioral children discover no locational agents unless includeLocationalAgents is true."
			: "Delegate exactly one task to an isolated behavioral Pi agent and wait for its result. Requires id, session, and task. Behavioral agents inherit the caller directory. Locational agents are disabled; includeLocationalAgents cannot enable them.",
		promptSnippet: "Delegate one foreground-managed task to an isolated Pi agent and wait for its result",
		parameters: SubagentParams,
		async execute(_toolCallId: string, params: SubagentToolParams, signal: AbortSignal | undefined, onUpdate: OnUpdateCallback | undefined, ctx: ExtensionContext) {
			const trusted = ctx.isProjectTrusted();
			const discovery = discoverAgents(ctx.cwd, trusted);
			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				includeLocationalAgents: locationalAgentsEnabled() && (params.includeLocationalAgents ?? false),
				locationalAgents: discovery.locationalAgents.map((agent) => agent.id),
				results,
			});
			const missingSession = getMissingSessionError(params);
			if (missingSession || !params.id || !params.task || !params.session) {
				return {
					content: [{ type: "text", text: missingSession ?? "Invalid parameters. id, session, and task are required." }],
					details: makeDetails([]),
					isError: true,
				};
			}
			if (!trusted && resolveLocationalAgentId(ctx.cwd, params.id)) {
				const message = "Locational subagents are unavailable because this project is not trusted.";
				return {
					content: [{ type: "text", text: message }],
					details: makeDetails([makeErrorResult(params.id, params.task, message, params.session)]),
					isError: true,
				};
			}
			const result = await runDelegation(
				pi,
				ctx,
				ctx.cwd,
				discovery.agents,
				params.id,
				params.session,
				addContextDocsToTask(params.task, params.contextDocs),
				signal,
				onUpdate,
				makeDetails,
				params.includeLocationalAgents ?? false,
			);
			if (isFailedResult(result)) {
				return {
					content: [{ type: "text", text: `Subagent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
					details: makeDetails([result]),
					usage: result.nativeUsage,
					isError: true,
				};
			}
			return { content: [{ type: "text", text: getResultOutput(result) }], details: makeDetails([result]), usage: result.nativeUsage };
		},
		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,
	});
}
