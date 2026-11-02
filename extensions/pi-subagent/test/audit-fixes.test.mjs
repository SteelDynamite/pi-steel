import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, promises as fs, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useFakePi } from "./fixtures/pi-host.mjs";
import { processChildJsonEvent, runDelegation, classifyContextLimitFailure } from "../execution.ts";
import { getFinalOutput } from "../result.ts";
import { applyNestedSubagentEvent } from "../nested.ts";
import { NESTED_SUBAGENT_DETAIL_CAP } from "../constants.ts";
import { trackedSessions, updateTrackedSession, getRequiredSessionIntent, persistSubagentState, restoreSubagentState } from "../state.ts";

const details = results => ({ includeLocationalAgents: false, locationalAgents: [], results });
const usage = () => ({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, reasoning: 1, cost: { input: .1, output: .2, cacheRead: .3, cacheWrite: .4, total: 1 } });
const result = () => ({ agent: "custom", task: "work", exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, cost: 0, turns: 0 } });

test("final answer preserves ordered text, ignores thinking and tool-only tails", () => {
 assert.equal(getFinalOutput([{ role: "assistant", content: [{ type: "text", text: "first" }, { type: "thinking", thinking: "secret" }, { type: "text", text: "last" }] }, { role: "assistant", content: [{ type: "toolCall", name: "read" }] }]), "first\nlast");
});

test("recovered context failure does not poison terminal success; final failure and abort retain classification", () => {
 const r = result();
 for (const message of [{ role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded", content: [] }, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] }]) processChildJsonEvent({ type: "message_end", message }, r, () => {});
 assert.equal(classifyContextLimitFailure(r), false);
 assert.equal(r.errorMessage, undefined);
 r.exitCode = 1; r.stopReason = "error"; r.errorMessage = "context_length_exceeded";
 assert.equal(classifyContextLimitFailure(r), true);
 r.stopReason = "aborted";
 assert.equal(classifyContextLimitFailure(r), false);
});

test("native usage includes child assistants and descendant tool results once", () => {
 const r = result();
 processChildJsonEvent({ type: "message_end", message: { role: "assistant", content: [], usage: usage() } }, r, () => {});
 const message = { role: "toolResult", toolCallId: "nested", content: [], usage: usage() };
 processChildJsonEvent({ type: "message_end", message }, r, () => {});
 processChildJsonEvent({ type: "tool_result_end", message }, r, () => {});
 assert.equal(r.nativeUsage.totalTokens, 28);
 assert.equal(r.nativeUsage.cost.total, 2);
 assert.equal(r.nativeUsage.reasoning, 2);
});

test("nested complete serialization is bounded, including escaped/multibyte errors and unknown fields", () => {
 const r = result();
 const child = { ...result(), unknown: "x".repeat(100000), agent: "x".repeat(100000), task: "\u0000".repeat(100000) };
 applyNestedSubagentEvent(r, { type: "tool_execution_end", toolName: "subagent", toolCallId: "nested", isError: true, result: { content: [{ type: "text", text: "😀\u0000".repeat(100000) }], details: details([child]) } });
 const nested = r.nestedSubagents[0];
 assert.ok(Buffer.byteLength(JSON.stringify(nested)) <= NESTED_SUBAGENT_DETAIL_CAP);
 assert.match(nested.error, /truncated/);
 assert.ok(!nested.error.includes("\ufffd"));
 assert.equal(nested.truncated, true);
});

test("failed resume clears saved ownership consistently through branch restoration", () => {
 trackedSessions.clear();
 let branch = [];
 const ctx = { cwd: "/test", sessionManager: { getSessionId: () => "parent", getBranch: () => branch } };
 const agent = { id: "custom", resumable: true };
 const first = result(); updateTrackedSession(ctx, agent, "child", first);
 assert.equal(getRequiredSessionIntent(ctx, agent).intent, "resume");
 const failed = { ...result(), exitCode: 130, stopReason: "aborted" };
 updateTrackedSession(ctx, agent, "child", failed);
 persistSubagentState({ appendEntry(customType, data) { branch = [{ type: "custom", customType, data }]; } });
 restoreSubagentState(ctx);
 assert.equal(failed.nextSessionIntent, "new");
 assert.equal(getRequiredSessionIntent(ctx, agent).intent, "new");
});

test("resumable reservations span error, abort, close and persistence; distinct parents stay concurrent", async () => {
 const root = mkdtempSync(join(tmpdir(), "pi-reservation-"));
 const script = join(root, "pi.cjs"); writeFileSync(script, "");
 const restorePi = useFakePi(root, script);
 const original = childProcess.spawn;
 const children = [];
 childProcess.spawn = () => { const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.exitCode = null; proc.kill = () => true; children.push(proc); return proc; };
 syncBuiltinESMExports();
 trackedSessions.clear();
 const agent = { id: "custom", kind: "behavioral", origin: "user", resumable: true, systemPrompt: "", filePath: script };
 const ctx = { cwd: root, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "parent" }, modelRegistry: { getAvailable: () => [] } };
 const run = (context, intent = "new", signal) => runDelegation({ appendEntry() {} }, context, root, [agent], agent.id, intent, "task", signal, undefined, details, false);
 try {
  const first = run(ctx);
  while (!children.length) await new Promise(resolve => setImmediate(resolve));
  const busy = await run(ctx); assert.match(busy.stderr, /active call/); assert.equal(children.length, 1);
  let settled = false; first.then(() => { settled = true; });
  children[0].emit("error", new Error("kill failure"));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  assert.match((await run(ctx)).stderr, /active call/);
  const other = run({ ...ctx, sessionManager: { getSessionId: () => "other" } });
  while (children.length < 2) await new Promise(resolve => setImmediate(resolve));
  children[1].emit("close", 0); await other;
  children[0].emit("close", 1); await first;
  const next = run(ctx); while (children.length < 3) await new Promise(resolve => setImmediate(resolve));
  children[2].emit("close", 0); assert.equal((await next).nextSessionIntent, "resume");
  const controller = new AbortController(); const resumed = run(ctx, "resume", controller.signal);
  while (children.length < 4) await new Promise(resolve => setImmediate(resolve));
  const aliasCtx = { ...ctx, sessionManager: { getSessionId: () => "alias-parent" } };
  updateTrackedSession(aliasCtx, agent, getRequiredSessionIntent(ctx, agent).record.sessionId, result());
  assert.match((await run(aliasCtx, "resume")).stderr, /active call/);
  assert.equal(children.length, 4);
  children[3].kill = () => { throw new Error("kill denied"); };
  controller.abort(); children[3].emit("error", new Error("late error"));
  assert.match((await run(ctx, "resume")).stderr, /active call/);
  children[3].emit("close", 0);
  const aborted = await resumed;
  assert.equal(aborted.stopReason, "aborted"); assert.match(aborted.errorMessage, /late error/); assert.match(aborted.errorMessage, /kill denied/);
  children[3].emit("error", new Error("after close"));
  assert.doesNotMatch(aborted.errorMessage, /after close/);
  assert.equal(getRequiredSessionIntent(ctx, agent).intent, "new");
 } finally { childProcess.spawn = original; syncBuiltinESMExports(); restorePi(); trackedSessions.clear(); rmSync(root, { recursive: true, force: true }); }
});

test("same-session fallback retains reservation and accounts for both attempts", async () => {
 const root = mkdtempSync(join(tmpdir(), "pi-fallback-reservation-"));
 const script = join(root, "pi.cjs"); writeFileSync(script, "");
 writeFileSync(join(root, "SUBAGENTS.md"), "---\nmodel: provider/explicit\n---\nOwner\n");
 const restorePi = useFakePi(root, script); const previousGate = process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS;
 process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS = "1";
 const original = childProcess.spawn; const children = []; const argsSeen = [];
 childProcess.spawn = (_command, args) => { argsSeen.push(args); const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.exitCode = null; proc.kill = () => true; children.push(proc); return proc; }; syncBuiltinESMExports();
 const ctx = { cwd: root, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "fallback-parent" }, model: { provider: "caller", id: "default" }, modelRegistry: { getAvailable: () => [{ provider: "provider", id: "explicit" }] } };
 const run = () => runDelegation({ appendEntry() {} }, ctx, root, [], root, "new", "task", undefined, undefined, details, false);
 try {
  const pending = run(); while (children.length < 1) await new Promise(resolve => setImmediate(resolve));
  children[0].stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider unavailable", usage: usage() } }) + "\n");
  children[0].emit("close", 1);
  while (children.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.match((await run()).stderr, /active call/);
  assert.equal(argsSeen[0][argsSeen[0].indexOf("--session-id") + 1], argsSeen[1][argsSeen[1].indexOf("--session-id") + 1]);
  children[1].stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: usage() } }) + "\n");
  children[1].emit("close", 0);
  const completed = await pending;
  assert.equal(completed.nativeUsage.cost.total, 2); assert.equal(completed.nextSessionIntent, "resume");
 } finally { childProcess.spawn = original; syncBuiltinESMExports(); restorePi(); if (previousGate === undefined) delete process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS; else process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS = previousGate; rmSync(root, { recursive: true, force: true }); }
});

test("prompt write rejection cleans temporary files and releases the resumable reservation", async () => {
 const root = mkdtempSync(join(tmpdir(), "pi-prompt-error-"));
 const script = join(root, "pi.cjs"); writeFileSync(script, ""); const restorePi = useFakePi(root, script);
 const originalWrite = fs.writeFile; const originalMkdtemp = fs.mkdtemp;
 let promptDir;
 fs.mkdtemp = async (...args) => { promptDir = await originalMkdtemp(...args); return promptDir; };
 fs.writeFile = async () => { throw new Error("prompt write denied"); };
 const agent = { id: "custom", kind: "behavioral", origin: "user", resumable: true, systemPrompt: "instructions", filePath: script };
 const ctx = { cwd: root, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "prompt-failure" }, modelRegistry: { getAvailable: () => [] } };
 try {
  for (let i = 0; i < 2; i++) {
   const r = await runDelegation({ appendEntry() {} }, ctx, root, [agent], agent.id, "new", "task", undefined, undefined, details, false);
   assert.match(r.errorMessage, /prompt write denied/); assert.equal(r.nextSessionIntent, "new");
   assert.equal(existsSync(promptDir), false);
  }
 } finally { fs.writeFile = originalWrite; fs.mkdtemp = originalMkdtemp; restorePi(); rmSync(root, { recursive: true, force: true }); }
});

test("live process error does not settle until confirmed termination", async () => {
 const root = mkdtempSync(join(tmpdir(), "pi-live-error-"));
 const script = join(root, "pi.cjs");
 writeFileSync(script, `process.on("SIGTERM", () => process.exit(0)); console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"ready"}],stopReason:"stop"}})); setInterval(() => {}, 1000);`);
 const restorePi = useFakePi(root, script);
 const original = childProcess.spawn;
 let child;
 childProcess.spawn = (...args) => { child = original(...args); return child; }; syncBuiltinESMExports();
 const controller = new AbortController();
 const agent = { id: "live", kind: "behavioral", origin: "user", resumable: true, systemPrompt: "", filePath: script };
 const ctx = { cwd: root, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "live-error" }, modelRegistry: { getAvailable: () => [] } };
 try {
  let settled = false;
  let ready; const readiness = new Promise(resolve => { ready = resolve; });
  const pending = runDelegation({ appendEntry() {} }, ctx, root, [agent], agent.id, "new", "task", controller.signal, ready, details, false);
  pending.then(() => { settled = true; });
  await readiness;
  child.emit("error", new Error("injected process error"));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(child.exitCode, null);
  controller.abort();
  const completed = await pending;
  assert.equal(completed.stopReason, "aborted"); assert.notEqual(child.exitCode, null);
 } finally { controller.abort(); childProcess.spawn = original; syncBuiltinESMExports(); restorePi(); rmSync(root, { recursive: true, force: true }); }
});

test("real failed spawn settles on close and releases reservation", async () => {
 const root = mkdtempSync(join(tmpdir(), "pi-spawn-failure-"));
 const script = join(root, "pi.cjs"); writeFileSync(script, ""); const restorePi = useFakePi(root, script);
 const agent = { id: "custom", kind: "behavioral", origin: "user", resumable: true, systemPrompt: "", filePath: script };
 const ctx = { cwd: join(root, "missing"), isProjectTrusted: () => true, sessionManager: { getSessionId: () => "spawn-failure" }, modelRegistry: { getAvailable: () => [] } };
 try {
  for (let i = 0; i < 2; i++) {
   const r = await runDelegation({ appendEntry() {} }, ctx, ctx.cwd, [agent], agent.id, "new", "task", undefined, undefined, details, false);
   assert.equal(r.stopReason, "error"); assert.match(r.errorMessage, /ENOENT/);
  }
 } finally { restorePi(); rmSync(root, { recursive: true, force: true }); }
});
