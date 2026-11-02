// Explicit host contract probe: node tests/host-probe.mjs /path/to/pi-coding-agent
// Run with an isolated HOME and PI_CODING_AGENT_DIR. No network/provider calls.
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(process.argv[2]);
const host = (path) => import(pathToFileURL(join(root, path)).href);
const { loadExtensions } = await host("dist/core/extensions/loader.js");
const { ModelRuntime } = await host("dist/core/model-runtime.js");
const { ModelRegistry } = await host("dist/core/model-registry.js");
const { createAssistantMessageEventStream } = await host("node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js");
const directory = fileURLToPath(new URL("..", import.meta.url));
const loaded = await loadExtensions([join(directory, "index.ts")], directory);
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
const runtime = await ModelRuntime.create({
	authPath: join(process.env.PI_CODING_AGENT_DIR, "auth.json"),
	modelsPath: null,
	refreshOnCreate: false,
	allowModelNetwork: false,
});
let requests = 0;
const messages = [];
// Extension actions are wired by the host after loading.
loaded.runtime.sendMessage = (message) => messages.push(message);
runtime.registerProvider("openai", {
	api: "openai-responses", baseUrl: "https://local.invalid/v1", apiKey: "synthetic-test-key",
	headers: { "x-test-route": "local" },
	models: [{ id: "physical-answer-test", name: "Local test", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	streamSimple(model, _context, options) {
		requests++;
		assert.equal(model.id, "physical-answer-test");
		assert.equal(model.baseUrl, "https://local.invalid/v1");
		assert.equal(options.apiKey, "synthetic-test-key");
		assert.equal(options.headers["x-test-route"], "local");
		assert.ok(options.signal instanceof AbortSignal);
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: {
			role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
			content: [{ type: "text", text: JSON.stringify({ questions: [{ question: "Local question?" }] }) }],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		} });
		return stream;
	},
});
runtime.registerVirtualModel({
	provider: "openai", id: "gpt-6.1-sol", name: "Fixed extraction route", contextWindow: 4096, maxTokens: 256,
	route(request) {
		assert.equal(request.reason, "direct");
		return { model: runtime.getModel("openai", "physical-answer-test"), thinkingLevel: "off" };
	},
});
const registry = new ModelRegistry(runtime);
await extension.commands.get("answer").handler("", {
	hasUI: true, modelRegistry: registry,
	sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Question?" }] } }] },
	ui: { custom: async () => undefined, editor: async () => "Local answer", notify() {} },
});
assert.equal(requests, 1);
assert.equal(messages.length, 1);
assert.match(messages[0].content, /Local answer/);
console.log("Actual host loader, virtual routing, endpoint, headers, auth, and neutral dispatch passed.");
