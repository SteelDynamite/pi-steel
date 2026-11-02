import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { __test__ } from "../src/index.ts";

const hostRoot = new URL("../../../node_modules/@earendil-works/", import.meta.url);
const hostFile = new URL("pi-coding-agent/dist/core/model-runtime.js", hostRoot);

test("real Pi dispatch preserves resolved endpoint/env and virtual routing", { skip: !existsSync(hostFile) }, async () => {
 const { ModelRuntime } = await import(hostFile.href);
 const { ModelRegistry } = await import(new URL("pi-coding-agent/dist/core/model-registry.js", hostRoot).href);
 const { createAssistantMessageEventStream } = await import(new URL("pi-ai/dist/index.js", hostRoot).href);
 const home = mkdtempSync(join(tmpdir(), "suggestion-host-"));
 try {
  const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const model = { ...runtime.getModels()[0], id: "physical", provider: "local-test" };
  let dispatched: any;
  runtime.registerNativeProvider({
   id: model.provider, name: "Local test", auth: {}, getModels: () => [model],
   stream() { throw new Error("use provider-neutral dispatch"); },
   streamSimple(requestModel: any, _context: any, options: any) {
    dispatched = { model: requestModel, options };
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "run the tests" }], api: model.api, model: model.id, provider: model.provider, stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
    return stream;
   },
  });
  // Stub only credential resolution, retaining Pi's real request preparation and router.
  runtime.getAuth = async () => ({ auth: { apiKey: "synthetic", headers: { "x-test": "resolved" }, baseUrl: "http://127.0.0.1/not-contacted" }, env: { TEST_ROUTE: "resolved" } });
  runtime.hasConfiguredAuth = () => true;
  runtime.registerVirtualModel({ provider: "router-test", id: "auto", route: () => ({ model, thinkingLevel: "off" }) });
  const registry = new ModelRegistry(runtime);
  const signal = new AbortController().signal;
  const text = await __test__.generateSuggestion([], { cwd: home, modelRegistry: registry } as any, registry.find("router-test", "auto"), __test__.mergeConfigInputs(), signal);
  assert.equal(text, "run the tests");
  assert.equal(dispatched.model.id, "physical");
  assert.equal(dispatched.model.baseUrl, "http://127.0.0.1/not-contacted");
  assert.equal(dispatched.options.apiKey, "synthetic");
  assert.equal(dispatched.options.headers["x-test"], "resolved");
  assert.equal(dispatched.options.env.TEST_ROUTE, "resolved");
  assert.equal(dispatched.options.signal, signal);
 } finally { rmSync(home, { recursive: true, force: true }); }
});
