export type AgentLifecyclePhase = "starting" | "running" | "terminating" | "closed";

export interface AgentLifecycleState {
	id: string;
	phase: AgentLifecyclePhase;
	startedAt: number;
	lastActivityAt: number;
	terminatedAt?: number;
	exitCode?: number;
	stopReason?: "aborted" | "error" | string;
	errorMessage?: string;
}

export function createAgentLifecycle(id: string, now = Date.now()): AgentLifecycleState {
	return { id, phase: "starting", startedAt: now, lastActivityAt: now };
}

export function markAgentActivity(state: AgentLifecycleState, now = Date.now()): void {
	if (state.phase === "closed") return;
	state.lastActivityAt = now;
	if (state.phase === "starting") state.phase = "running";
}

export function markAgentTerminating(state: AgentLifecycleState, now = Date.now()): boolean {
	if (state.phase === "closed" || state.phase === "terminating") return false;
	state.phase = "terminating";
	state.lastActivityAt = now;
	state.stopReason = "aborted";
	state.errorMessage = "Subagent was aborted.";
	return true;
}

export function recordAgentError(state: AgentLifecycleState, message: string, now = Date.now()): void {
	if (state.phase === "closed") return;
	state.lastActivityAt = now;
	state.stopReason = "error";
	state.errorMessage = message;
}

export function markAgentClosed(state: AgentLifecycleState, exitCode: number, now = Date.now()): void {
	if (state.phase === "closed") return;
	state.phase = "closed";
	state.lastActivityAt = now;
	state.terminatedAt = now;
	state.exitCode = exitCode;
}
