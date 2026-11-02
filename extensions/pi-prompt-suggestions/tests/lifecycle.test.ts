import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import promptSuggestions, { __test__ } from "../src/index.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("optional generation returns immediately and cancellation rejects hung auth", async () => {
 const home = mkdtempSync(join(tmpdir(), "suggestions-"));
 const old = process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR = home;
 const handlers = new Map<string, Function>();
 let resolveAuth: Function = () => {};
 let authCalls = 0;
 let editors = 0;
 const model = { provider: "test", id: "local", reasoning: false };
 const ctx: any = {
  cwd: home, hasUI: true, mode: "tui", model,
  hasPendingMessages: () => false,
  modelRegistry: { find: () => model, getApiKeyAndHeaders: () => {
   authCalls++;
   return new Promise((resolve) => { resolveAuth = resolve; });
  } },
  ui: { setWidget() {}, setStatus() {}, notify() {}, getEditorText: () => "", setEditorComponent(factory: Function) { editors++; factory({ requestRender() {} }, { borderColor: (text: string) => text }, { matches: () => false }); } },
 };
 try {
  promptSuggestions({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
  handlers.get("session_start")!({}, ctx);
  assert.equal(handlers.get("agent_end")!({ messages: [] }, ctx), undefined);
  assert.equal(authCalls, 1);
  handlers.get("agent_start")!({}, ctx);
  resolveAuth({ ok: false });
  await tick();
  handlers.get("session_shutdown")!({}, ctx);
  assert.equal(editors, 1, "shutdown must not reset another extension's editor");
  mkdirSync(join(home, ".pi"));
  writeFileSync(join(home, ".pi", "prompt-suggestions.json"), '{"enabled":false}');
  handlers.get("session_start")!({}, ctx);
  assert.equal(editors, 1, "disabled startup preserves the installed editor");
 } finally {
  if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
  rmSync(home, { recursive: true, force: true });
 }
});

test("abort releases ownership even if provider never settles", async () => {
 const controller = new AbortController();
 const result = __test__.withCancellation(new Promise<never>(() => {}), controller.signal);
 controller.abort();
 await assert.rejects(result);
});

test("host-neutral dispatch receives the signal and ignores failed response text", async () => {
 const controller = new AbortController();
 let options: any;
 const ctx: any = {
  cwd: tmpdir(),
  modelRegistry: {
   getApiKeyAndHeaders() { throw new Error("must not pre-resolve virtual-model auth"); },
   streamSimple(_model: unknown, _context: unknown, value: unknown) {
    options = value;
    return { result: async () => ({ stopReason: "aborted", content: [{ type: "text", text: "run the tests" }] }) };
   },
  },
 };
 const result = await __test__.generateSuggestion([], ctx, {} as any, __test__.mergeConfigInputs(), controller.signal);
 assert.equal(options.signal, controller.signal);
 assert.equal(result, "");
});
