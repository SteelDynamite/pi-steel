/**
 * Remind the agent when a session is resumed, as application state may have changed.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };
type SessionStartEvent = { type: "session_start"; reason?: string };

export default function (_pi: ExtensionAPI) {
	return {
		on: "session_start",
		when: ({ event }: { event: SessionStartEvent }) => event.reason === "resume",
		triggerTurn: false,
		message: "This session is being resumed. Application state may have changed since last time. Re-read relevant files before making assumptions about current state.",
	};
}
