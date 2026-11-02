import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// Only loaded by host.test.ts in its isolated child process.
export default function (pi: any) {
	const state = (globalThis as any).__todoHost;
	pi.on("tool_result", async (event: any) => {
		if (state.siblings && event.toolName === "todo" && !event.parentToolCallId) {
			await new Promise<void>(resolve => { state.releaseDirect = resolve; });
		}
	});
	pi.on("agent_before_settle", (event: any) => {
		(state.boundaries ??= []).push({ outcome: event.outcome, canContinue: event.context.canContinue, entries: event.entries });
	});
	pi.registerTool({
		name: "nested_todo", label: "Nested todo", description: "Host regression fixture", parameters: Type.Object({}),
		async execute(_id: string, _args: unknown, _signal: unknown, _update: unknown, ctx: any) {
			const outcome = await ctx.executeTool("todo", state.action);
			state.result = { ...outcome.result, isError: outcome.isError };
			state.releaseDirect?.();
			return state.result;
		},
	});
	pi.registerProvider("todo-local", {
		api: "todo-local", baseUrl: "http://invalid.invalid", apiKey: "local-fixture",
		models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model: any, _context: unknown, options: any) {
			state.requests++;
			const stream = createAssistantMessageEventStream();
			const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				timestamp: Date.now(), content: [], stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			queueMicrotask(() => {
				if (state.abort) {
					const finish = () => {
						message.stopReason = "aborted";
						stream.push({ type: "error", reason: "aborted", error: message });
						stream.end();
					};
					if (options.signal.aborted) finish();
					else options.signal.addEventListener("abort", finish, { once: true });
					state.started();
					return;
				}
				if (state.call) {
					state.call = false;
					message.content = state.siblings
						? [{ type: "toolCall", id: `direct-${state.requests}`, name: "todo", arguments: { action: "add", items: ["sibling"], replace: true } },
							{ type: "toolCall", id: `nested-${state.requests}`, name: "nested_todo", arguments: {} }]
						: [{ type: "toolCall", id: `todo-${state.requests}`, name: state.nested ? "nested_todo" : "todo", arguments: state.nested ? {} : state.action }];
					message.stopReason = "toolUse";
				} else message.content = [{ type: "text", text: "done" }];
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end();
			});
			return stream;
		},
	});
}
