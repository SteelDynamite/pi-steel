import assert from "node:assert/strict";
import { useFakePi } from "./fixtures/pi-host.mjs";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runDelegation } from "../execution.ts";
import { subagentSettings, trackedSessions } from "../state.ts";

const details = (results) => ({ includeLocationalAgents: false, locationalAgents: [], results });
const start = { type: "message_start", message: { role: "assistant", content: [], timestamp: 9999999999999 } };
const delta = (text, type = "thinking_delta") => ({ type: "message_update", usage: { output: 0 }, assistantMessageEvent: { type, contentIndex: 0, delta: text } });
const end = (output, failed = false) => ({ type: "message_end", message: { role: "assistant", content: failed ? [] : [{ type: "text", text: "done" }], usage: { output, totalTokens: output }, stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage: "provider unavailable" } : {}) } });
const lines = (...events) => events.map((event) => JSON.stringify(event) + "\n").join("");

test("JSON transport preserves per-launch speed from receipt through final details", async (t) => {
 const root = mkdtempSync(join(tmpdir(), "pi-subagent-token-speed-"));
 const script = join(root, "fake-pi.cjs");
 writeFileSync(script, "");
 const restorePi = useFakePi(root, script);
 const originalReuse = subagentSettings.reuseEnabled;
 const originalTracked = new Map(trackedSessions);
 const env = new Map(["PI_CHATGPT_SPEED", "PI_SUBAGENT_DEPTH"].map((key) => [key, process.env[key]]));
 let at = 0;
 // Exercise the real stdout parser with deterministic pipe chunks, without a
 // model or OS scheduling deciding whether separate writes arrive together.
 const spawn = t.mock.method(childProcess, "spawn", (_command, args) => {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const task = args.at(-1).slice("Task: ".length);
  const failed = args[args.indexOf("--model") + 1] === "provider/unavailable";
  queueMicrotask(() => {
   const send = (time, data) => { at = time; proc.stdout.write(data); };
   const first = lines(start, delta("first chunk"));
   if (task === "bundled") {
    send(1000, first + lines(delta("abcdefgh"), end(11)));
   } else if (task === "no-deltas") {
    send(1000, lines(start, end(11)));
   } else {
    send(1000, first);
    if (task === "split-utf8") {
     const bytes = Buffer.from(lines(delta("😀\u2028\u2029", "text_delta")));
     const split = bytes.indexOf(Buffer.from("😀")) + 1;
     send(1500, bytes.subarray(0, split));
     send(2000, bytes.subarray(split));
    } else {
     send(2000, task === "batched-progress"
      ? lines(delta("abcd", "text_delta"), delta("abcd", "toolcall_delta"))
      : lines(delta("abcdefgh")));
    }
    if (task !== "interrupted") {
     // An unterminated final record is consumed on close, not lost. Tail time
     // and cumulative usage must not inflate the measured generation period.
     const output = task === "split-utf8" ? 0 : failed ? 101 : task === "resume" ? 21 : 11;
     send(90000, JSON.stringify(end(output, failed)));
     if (task === "interrupted-after-complete") {
      send(100000, "\n" + first);
      send(101000, lines(delta("unfinished")));
     }
    }
   }
   proc.stdout.end(); proc.stderr.end();
   proc.emit("close", failed || task.startsWith("interrupted") ? 1 : 0);
  });
  return proc;
 });
 syncBuiltinESMExports();
 try {
  process.env.PI_SUBAGENT_DEPTH = "0";
  process.env.PI_CHATGPT_SPEED = "ultrafast";
  subagentSettings.reuseEnabled = true;
  trackedSessions.clear();
  const model = { provider: "openai", id: "gpt-6-astra", contextWindow: 10000 };
  const ctx = {
   cwd: root, model, isProjectTrusted: () => true,
   sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
   modelRegistry: { getAvailable: () => [{ provider: "provider", id: "unavailable" }], isUsingOAuth: () => true },
  };
  const definition = { id: "speed", kind: "behavioral", origin: "user", rootDir: root, filePath: join(root, "SUBAGENTS.md"), manifest: true, description: "", systemPrompt: "", resumable: true };
  const launch = async (id, session, task) => {
   const updates = [];
   const result = await runDelegation({ appendEntry() {} }, ctx, root, [definition], id, session, task, undefined, (update) => {
    updates.push(structuredClone(update.details));
    if (task === "batched-progress") at += 10000; // Slow rendering is not generation time.
   }, details, false, () => at++);
   return { result, updates };
  };
  await t.test("new, resume and fallback reset measurements and preserve requested speed", async () => {
   const first = await launch("speed", "new", "new");
   assert.deepEqual(first.result.tokenSpeed, { mode: "aggregate", tokens: 10, durationMs: 1000 });
   assert.deepEqual(first.updates.map((d) => d.results[0].tokenSpeed.mode), ["live", "aggregate"]);
   assert.equal(first.result.nextSessionIntent, "resume");
   const resumed = await launch("speed", "resume", "resume");
   assert.deepEqual(resumed.result.tokenSpeed, { mode: "aggregate", tokens: 20, durationMs: 1000 });
   assert.deepEqual(first.result.tokenSpeed, { mode: "aggregate", tokens: 10, durationMs: 1000 });
   const owner = join(root, "owner");
   mkdirSync(owner);
   writeFileSync(join(owner, "SUBAGENTS.md"), "---\nmodel: provider/unavailable\nresumable: false\n---\n");
   const fallback = await launch(owner, "new", "fallback");
   assert.match(fallback.result.warning, /retried with caller model/);
   assert.deepEqual(fallback.result.tokenSpeed, { mode: "aggregate", tokens: 10, durationMs: 1000 });
   assert.deepEqual(fallback.updates.map((d) => d.results[0].tokenSpeed), [
    { mode: "live", tokens: 2, durationMs: 1000 }, { mode: "aggregate", tokens: 100, durationMs: 1000 },
    { mode: "live", tokens: 2, durationMs: 1000 }, { mode: "aggregate", tokens: 10, durationMs: 1000 },
   ]);
   assert.deepEqual(fallback.updates.map((d) => d.results[0].requestedSpeed), [undefined, undefined, "ultrafast", "ultrafast"]);
   assert.equal(fallback.result.requestedSpeed, "ultrafast");
  });
  // Each case is independent of the previous resumable result.
  for (const task of ["no-deltas", "bundled", "interrupted", "interrupted-after-complete", "batched-progress", "split-utf8"]) {
   await t.test(task, async () => {
    trackedSessions.clear();
    const { result, updates } = await launch("speed", "new", task);
    if (["no-deltas", "bundled", "interrupted"].includes(task)) assert.equal(result.tokenSpeed, undefined);
    else assert.deepEqual(result.tokenSpeed, { mode: "aggregate", tokens: task === "split-utf8" ? 1 : 10, durationMs: 1000 });
    if (task === "interrupted") assert.equal(updates[0].results[0].tokenSpeed.mode, "live");
    if (task === "batched-progress") assert.equal(updates.filter((d) => d.results[0].tokenSpeed.mode === "live").length, 1);
    if (task === "split-utf8") assert.equal(updates[0].results[0].tokenSpeed.tokens, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(details([result]))).results[0].tokenSpeed, result.tokenSpeed);
   });
  }
 } finally {
  spawn.mock.restore(); syncBuiltinESMExports();
  restorePi();
  subagentSettings.reuseEnabled = originalReuse;
  trackedSessions.clear();
  for (const [key, value] of originalTracked) trackedSessions.set(key, value);
  for (const [key, value] of env) {
   if (value === undefined) delete process.env[key];
   else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
 }
});
