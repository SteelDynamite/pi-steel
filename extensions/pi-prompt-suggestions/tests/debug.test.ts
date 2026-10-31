import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import {
	createAssistantMessageEventStream,
	registerApiProvider,
	unregisterApiProviders,
	type AssistantMessage,
	type Model,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import promptSuggestions from "../src/index.ts";
import type { ExtensionContext } from "../src/pi-local.ts";

for (const enabled of [false, true]) {
	it(enabled ? "escapes provider and auth controls in debug UI and logs" : "keeps debug UI and logging disabled by default", async (t) => {
		const cwd = mkdtempSync(join(process.cwd(), ".suggestion-test-"));
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const oldDebug = process.env.PI_PROMPT_SUGGESTIONS_DEBUG;
		t.after(() => {
			unregisterApiProviders("suggestion-debug-test");
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			if (oldDebug === undefined) delete process.env.PI_PROMPT_SUGGESTIONS_DEBUG;
			else process.env.PI_PROMPT_SUGGESTIONS_DEBUG = oldDebug;
			rmSync(cwd, { recursive: true, force: true });
		});
		process.env.PI_CODING_AGENT_DIR = cwd;
		if (enabled) process.env.PI_PROMPT_SUGGESTIONS_DEBUG = "1";
		else delete process.env.PI_PROMPT_SUGGESTIONS_DEBUG;
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "prompt-suggestions.json"), JSON.stringify({ display: "belowEditor" }));
		const controls = Array.from({ length: 160 }, (_, code) => code)
			.filter((code) => code < 32 || code >= 127)
			.map((code) => String.fromCharCode(code)).join("") + "\u2028\u2029";
		const error = `provider café 👩‍💻 literal \\u001b ${controls}\x1b]52;c;YXVkaXQ=\x07`;
		const response: AssistantMessage = {
			role: "assistant", content: [], api: "suggestion-debug-test", provider: "test", model: "test",
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error", errorMessage: error, timestamp: 1,
		};
		const stream: StreamFunction = () => {
			const events = createAssistantMessageEventStream();
			events.end(response);
			return events;
		};
		registerApiProvider({ api: "suggestion-debug-test", stream, streamSimple: stream }, "suggestion-debug-test");
		const model: Model<"suggestion-debug-test"> = {
			id: "test", name: "test", api: "suggestion-debug-test", provider: "test",
			baseUrl: "https://invalid.example", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256,
		};
		const statuses: string[] = [];
		const notifications: string[] = [];
		const ctx: ExtensionContext & { mode: "tui" } = {
			cwd, mode: "tui", hasUI: true, model, hasPendingMessages: () => false,
			modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
			ui: {
				setWidget: () => {}, setEditorComponent: () => {}, getEditorText: () => "",
				setStatus: (_key, text) => { if (text) statuses.push(text); },
				notify: (message) => { notifications.push(message); },
			},
		};
		const handlers = new Map<string, (event: never, ctx: ExtensionContext) => void | Promise<void>>();
		promptSuggestions({ on: (name, handler) => { handlers.set(name, handler); } });
		await handlers.get("session_start")!({} as never, ctx);
		await handlers.get("agent_end")!({ messages: [] } as never, ctx);
		ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error(error); };
		await handlers.get("agent_end")!({ messages: [] } as never, ctx);
		await handlers.get("session_shutdown")!({} as never, ctx);
		const logPath = join(cwd, "next-suggestion-debug.log");
		if (!enabled) {
			assert.equal(statuses.length, 0);
			assert.equal(notifications.length, 0);
			assert.equal(existsSync(logPath), false);
			return;
		}
		for (const messages of [statuses, notifications]) {
			assert.equal(messages.some((message) => message.includes("response: error")), true);
			assert.equal(messages.some((message) => message.includes("error: provider café 👩‍💻 literal \\u001b")), true);
			for (const message of messages) {
				// Assert booleans so even failures cannot print a terminal payload.
				assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(message), false);
			}
		}
		const log = readFileSync(logPath, "utf8");
		assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(log), false);
		assert.equal(log.includes("\\u001b]52;c;YXVkaXQ=\\u0007"), true);
		assert.equal(log.includes("\\u009d"), true);
	});
}
