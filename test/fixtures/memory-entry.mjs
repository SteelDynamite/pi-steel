import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import memory from "../../node_modules/pi-observational-memory/dist/index.ts";

const settings = JSON.parse(readFileSync(join(process.argv[2], "presets/memory/settings.json"), "utf8"));
// Initialize the unmodified distributed entry, not source-only hooks. All configuration
// and callbacks are isolated; no credentials, providers, or personal settings are used.
function initialize(overrides = {}) {
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({
    compaction: { enabled: false },
    "observational-memory": { ...settings["observational-memory"], compactionCatchUpMaxChunks: 0, ...overrides },
  }));
  const handlers = new Map();
  memory({
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerCommand() {}, registerTool() {},
  });
  return async (name, event, ctx) => {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx) ?? result;
    return result;
  };
}
const idleRun = initialize({ consolidateWhenIdle: true });
const idleContext = { cwd: process.env.HOME, sessionManager: { getBranch() { throw new Error("workers must not inspect history during active turns"); } } };
await idleRun("agent_start", {}, idleContext);
await idleRun("turn_end", {}, idleContext);
const run = initialize();
let tokens = 249999;
let compactions = 0;
const ctx = {
  cwd: process.env.HOME, hasUI: true, ui: { notify(message) { console.log(message); } }, model: { contextWindow: 1000000 }, isIdle: () => true,
  // Neither idle consolidation nor these compaction checks may resolve a provider.
  modelRegistry: { find() { throw new Error("unexpected provider access"); } },
  sessionManager: { getBranch: () => [
    { id: "source", type: "custom_message", content: "x".repeat(tokens * 4) },
    { id: "observed", type: "custom", customType: "om.observations.recorded", data: { observations: [], coversUpToId: "source" } },
  ] },
  compact({ onComplete }) { compactions++; onComplete(); },
};
await run("agent_settled", {}, ctx);
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(compactions, 0);
tokens = 250000;
await run("agent_settled", {}, ctx);
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(compactions, 1);

const raw = (id, role) => ({ id, type: "message", message: { role, content: [{ type: "text", text: id }], timestamp: 0 } });
const entries = [raw("u0", "user"), raw("a0", "assistant"), raw("u1", "user"), raw("a1", "assistant"), raw("u2", "user"), {
  id: "coverage", type: "custom", customType: "om.observations.recorded",
  data: { coversUpToId: "a0", observations: [{ id: "aaaaaaaaaaaa", content: "Recorded fact", timestamp: new Date(0).toISOString(), relevance: "medium", sourceEntryIds: ["a0"], tokenCount: 10 }] },
}];
const event = { preparation: { firstKeptEntryId: "u2", tokensBefore: 123 }, branchEntries: entries, reason: "threshold", willRetry: false };
ctx.sessionManager.getBranch = () => entries;
const retained = await run("session_before_compact", event, ctx);
assert.equal(retained.compaction.firstKeptEntryId, "u1", "unobserved source must remain in context");
assert.match(retained.compaction.summary, /Recorded fact/);
const catchUpFallback = await initialize({ compactionCatchUpMaxChunks: 1 })("session_before_compact", event, { ...ctx, model: undefined });
assert.equal(catchUpFallback.compaction.firstKeptEntryId, "u1", "unavailable catch-up model must preserve unobserved context");
assert.equal(await run("session_before_compact", { ...event, reason: "overflow" }, ctx), undefined, "overflow delegates to native summarizer");
assert.equal(await initialize({ compactionMaxRetainedTokens: 1 })("session_before_compact", event, ctx), undefined, "oversized retained tail delegates");
assert.equal(await initialize({ compactionSummaryMaxTokens: 1 })("session_before_compact", event, ctx), undefined, "memory exceeding summary budget delegates");
console.log("Distributed entry: 250k trigger, idle worker suppression, unobserved retention, overflow and budget delegation passed");
