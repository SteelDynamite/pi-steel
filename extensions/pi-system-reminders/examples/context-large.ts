/**
 * Remind the agent to compact when context gets large.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };
type ExtensionContext = { getContextUsage(): { tokens?: number | null; contextWindow: number } | undefined };

export default function (_pi: ExtensionAPI) {
	return {
		on: "turn_start",
		when: ({ ctx }: { ctx: ExtensionContext }) => (ctx.getContextUsage()?.tokens ?? 0) > 150_000,
		triggerTurn: false,
		message: "Context exceeds 150k tokens. Consider compacting to maintain quality.",
		once: true,
	};
}
