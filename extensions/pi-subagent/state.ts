import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import { DEFAULT_CONTEXT_THRESHOLD, SUBAGENT_STATE_ENTRY } from "./constants.ts";
import type { ExtensionAPI, ExtensionContext } from "./pi-compat.ts";
import { isFailedResult } from "./result.ts";
import type {
	NextIntentReason,
	PersistedSubagentState,
	SessionIntent,
	SingleResult,
	SubagentSettings,
	TrackedSession,
} from "./types.ts";

export let subagentSettings: SubagentSettings = { reuseEnabled: true, contextThreshold: DEFAULT_CONTEXT_THRESHOLD };
export const trackedSessions = new Map<string, TrackedSession>();

export function getMainSessionKey(ctx: ExtensionContext): string {
	const manager = ctx.sessionManager;
	return manager.getSessionFile?.() ?? manager.getSessionId?.() ?? `memory:${path.resolve(ctx.cwd)}`;
}

function sessionRecordKey(ctx: ExtensionContext, agentId: string): string {
	return `${getMainSessionKey(ctx)}\0${agentId}`;
}

export function restoreSubagentState(ctx: ExtensionContext): void {
	subagentSettings = { reuseEnabled: true, contextThreshold: DEFAULT_CONTEXT_THRESHOLD };
	trackedSessions.clear();
	let latest: PersistedSubagentState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === SUBAGENT_STATE_ENTRY) latest = entry.data as PersistedSubagentState | undefined;
	}
	if (!latest) return;
	const threshold = latest.settings?.contextThreshold;
	subagentSettings = {
		reuseEnabled: latest.settings?.reuseEnabled ?? true,
		contextThreshold: typeof threshold === "number" && threshold > 0 && threshold <= 1 ? threshold : DEFAULT_CONTEXT_THRESHOLD,
	};
	for (const record of latest.sessions ?? []) {
		trackedSessions.set(`${record.mainSessionKey}\0${record.agentId}`, record);
	}
}

export function persistSubagentState(pi: ExtensionAPI): void {
	pi.appendEntry<PersistedSubagentState>(SUBAGENT_STATE_ENTRY, {
		settings: subagentSettings,
		sessions: [...trackedSessions.values()],
	});
}

export function getRequiredSessionIntent(ctx: ExtensionContext, agent: AgentConfig): { intent: SessionIntent; reason: NextIntentReason; record?: TrackedSession } {
	if (!agent.resumable) return { intent: "new", reason: "non-resumable" };
	if (!subagentSettings.reuseEnabled) return { intent: "new", reason: "reuse-disabled" };
	const record = trackedSessions.get(sessionRecordKey(ctx, agent.id));
	return record ? { intent: record.nextIntent, reason: record.reason, record } : { intent: "new", reason: "none" };
}

export function getWrongIntentRetry(required: SessionIntent, reason: NextIntentReason): string {
	return reason === "over-threshold"
		? `Retry with session: "${required}" and craft a fresh-session task prompt.`
		: `Retry with session: "${required}".`;
}

export function formatWrongIntentReason(agent: AgentConfig, requested: SessionIntent, required: SessionIntent, reason: NextIntentReason): string {
	const retry = getWrongIntentRetry(required, reason);
	if (!agent.resumable) return `Wrong session intent for "${agent.id}": requested "${requested}", required "new" because this subagent is not resumable. ${retry}`;
	if (reason === "reuse-disabled") return `Wrong session intent for "${agent.id}": requested "${requested}", required "new" because resumable session reuse is disabled. ${retry}`;
	if (reason === "over-threshold") return `Wrong session intent for "${agent.id}": requested "${requested}", required "new" because the locational session is over the context limit. ${retry}`;
	if (reason === "none") return `Wrong session intent for "${agent.id}": requested "${requested}", required "new" because no prior reusable session exists. ${retry}`;
	return `Wrong session intent for "${agent.id}": requested "${requested}", required "${required}". ${retry}`;
}

export function updateTrackedSession(ctx: ExtensionContext, agent: AgentConfig, sessionId: string | undefined, result: SingleResult): void {
	if (!agent.resumable) return;
	if (!subagentSettings.reuseEnabled || !sessionId || isFailedResult(result)) {
		result.nextSessionIntent = "new";
		return;
	}
	const contextTokens = result.usage.contextTokens;
	const contextWindow = result.contextWindow;
	const overThreshold = Boolean(contextWindow && contextTokens > 0 && contextTokens / contextWindow >= subagentSettings.contextThreshold);
	const record: TrackedSession = {
		mainSessionKey: getMainSessionKey(ctx),
		agentId: agent.id,
		sessionId,
		nextIntent: overThreshold ? "new" : "resume",
		reason: overThreshold ? "over-threshold" : "under-threshold",
		contextTokens,
		contextWindow,
		updatedAt: Date.now(),
	};
	trackedSessions.set(sessionRecordKey(ctx, agent.id), record);
	result.nextSessionIntent = record.nextIntent;
}
