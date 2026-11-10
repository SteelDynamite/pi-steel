export type MaybePromise<T> = T | Promise<T>;

type BasicEvent<T extends string> = { type: T; [key: string]: unknown };

type ModelRef = { provider: string; id: string; [key: string]: unknown };

export type SessionEntry = {
	type?: string;
	customType?: string;
	details?: unknown;
	[key: string]: unknown;
};

export interface ExtensionContext {
	cwd: string;
	isProjectTrusted?(): boolean;
	sessionManager: {
		getBranch(): SessionEntry[];
		getSessionFile?(): string | undefined;
		[key: string]: unknown;
	};
	ui: {
		notify(message: string, level?: string): void;
		[key: string]: unknown;
	};
	getContextUsage?(): { tokens?: number | null; contextWindow: number; [key: string]: unknown } | undefined;
	[key: string]: unknown;
}

export type SessionStartEvent = BasicEvent<"session_start"> & { reason?: string };
export type AgentStartEvent = BasicEvent<"agent_start">;
export type BeforeAgentStartEvent = BasicEvent<"before_agent_start"> & {
	systemPrompt: string;
	systemPromptOptions: { sections: Record<string, string>; [key: string]: unknown };
};
export type ModelSelectEvent = BasicEvent<"model_select"> & { model: ModelRef; previousModel?: ModelRef | null };
export type ToolResultEvent = BasicEvent<"tool_result"> & {
	toolName: string;
	isError?: boolean;
	input?: unknown;
	content?: unknown;
	details?: unknown;
};
export type ToolExecutionEndEvent = BasicEvent<"tool_execution_end"> & {
	toolName?: string;
	isError?: boolean;
};

export type ExtensionEvent =
	| BasicEvent<"resources_discover">
	| SessionStartEvent
	| BasicEvent<"session_before_switch">
	| BasicEvent<"session_before_fork">
	| BasicEvent<"session_before_compact">
	| BasicEvent<"session_compact">
	| BasicEvent<"session_shutdown">
	| BasicEvent<"session_before_tree">
	| BasicEvent<"session_tree">
	| BasicEvent<"context">
	| BasicEvent<"before_provider_request">
	| BasicEvent<"after_provider_response">
	| BeforeAgentStartEvent
	| AgentStartEvent
	| BasicEvent<"agent_end">
	| BasicEvent<"turn_start">
	| BasicEvent<"turn_end">
	| BasicEvent<"message_start">
	| BasicEvent<"message_update">
	| BasicEvent<"message_end">
	| BasicEvent<"tool_execution_start">
	| BasicEvent<"tool_execution_update">
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| BasicEvent<"thinking_level_select">
	| BasicEvent<"tool_call">
	| ToolResultEvent
	| BasicEvent<"user_bash">
	| BasicEvent<"input">;

export interface ExtensionAPI {
	on<E extends ExtensionEvent["type"]>(
		event: E,
		handler: (event: Extract<ExtensionEvent, { type: E }>, ctx: ExtensionContext) => MaybePromise<unknown>,
	): void;
	on(event: string, handler: (event: any, ctx: ExtensionContext) => MaybePromise<unknown>): void;
	sendMessage(
		message: { customType: string; content: string; display?: boolean; details?: unknown; [key: string]: unknown },
		options?: { deliverAs?: string; triggerTurn?: boolean; [key: string]: unknown },
	): void;
	registerCommand?(
		name: string,
		command: { description?: string; handler: (args: string, ctx: ExtensionContext) => MaybePromise<unknown>; [key: string]: unknown },
	): void;
	[key: string]: unknown;
}
