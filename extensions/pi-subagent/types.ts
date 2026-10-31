import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentOrigin, ThinkingLevel } from "./agents.ts";

export type SessionIntent = "new" | "resume";
export type NextIntentReason = "none" | "under-threshold" | "over-threshold" | "reuse-disabled" | "non-resumable";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentSettings {
	reuseEnabled: boolean;
	contextThreshold: number;
}

export interface TrackedSession {
	mainSessionKey: string;
	agentId: string;
	sessionId: string;
	nextIntent: SessionIntent;
	reason: NextIntentReason;
	contextTokens: number;
	contextWindow?: number;
	updatedAt: number;
}

export interface PersistedSubagentState {
	settings: SubagentSettings;
	sessions: TrackedSession[];
}

export interface WrongSessionIntentError {
	agentId: string;
	requested: SessionIntent;
	required: SessionIntent;
	recommendedRetry: string;
}

/** Stored numerator/denominator, not wall-clock timestamps. Aggregate covers measurable calls in one launch attempt. */
export interface TokenSpeedMeasurement {
	mode: "live" | "aggregate";
	tokens: number;
	durationMs: number;
}

export interface SingleResult {
	agent: string;
	agentOrigin: AgentOrigin | "unknown";
	agentOverride?: boolean;
	agentThinking?: ThinkingLevel;
	/** Eligible launch-time intent, not child payload or server confirmation. Omission means unknown. */
	requestedSpeed?: "ultrafast";
	/** Live character estimate or completed duration-weighted aggregate; independent of requestedSpeed. */
	tokenSpeed?: TokenSpeedMeasurement;
	sessionIntent?: SessionIntent;
	wrongSessionIntent?: WrongSessionIntentError;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	stdout?: string;
	usage: UsageStats;
	model?: string;
	contextWindow?: number;
	warning?: string;
	stopReason?: string;
	errorMessage?: string;
	cwd?: string;
	nextSessionIntent?: SessionIntent;
	nestedSubagents?: NestedSubagentCall[];
}

export interface NestedSubagentCall {
	toolCallId: string;
	toolName: "subagent";
	status: "running" | "completed" | "failed";
	details?: SubagentDetails;
	error?: string;
	truncated?: boolean;
}

export interface SubagentDetails {
	includeLocationalAgents: boolean;
	locationalAgents: string[];
	results: SingleResult[];
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };
export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
