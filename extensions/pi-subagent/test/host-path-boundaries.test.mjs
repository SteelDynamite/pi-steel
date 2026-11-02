import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import subagent from "../index.ts";
import { resolveBuiltinTarget } from "../locational-guard.ts";
// Exercise the distribution's real host, not the module's older development facade.
import { resolveReadPath, resolveToCwd } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";
import { AgentSession, SessionManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { processChildJsonEvent } from "../execution.ts";
import { createReadTool } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js";

test("real host session statistics include child and descendant native tool usage", () => {
 const result = { messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
 const usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, cost: { input: .1, output: .2, cacheRead: .3, cacheWrite: .4, total: 1 } };
 processChildJsonEvent({ type: "message_end", message: { role: "assistant", content: [], usage } }, result, () => {});
 processChildJsonEvent({ type: "message_end", message: { role: "toolResult", toolCallId: "descendant", content: [], usage } }, result, () => {});
 const manager = SessionManager.inMemory();
 manager.appendMessage({ role: "toolResult", toolCallId: "subagent", toolName: "subagent", content: [], details: {}, isError: false, timestamp: Date.now(), usage: result.nativeUsage });
 const stats = AgentSession.prototype.getSessionStats.call({ sessionManager: manager, getContextUsage: () => undefined });
 assert.equal(stats.tokens.total, 28);
 assert.equal(stats.cost, 2);
});

process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS = "1";
function guard() {
 let handler;
 subagent({ on(name, fn) { if (name === "tool_call") handler = fn; }, registerCommand() {}, registerTool() {}, registerEntryRenderer() {} });
 return handler;
}

test("host read fallback paths resolve to guarded owners; writes retain native spelling", async () => {
 const root = mkdtempSync(join(tmpdir(), "pi-host-path-"));
 const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => true };
 const check = guard();
 try {
  for (const [directory, input] of [["owned", "@owned"], ["Capture\u202FAM.dir", "Capture AM.dir"], ["cafe\u0301", "café"], ["l’été", "l'été"]]) {
   const owner = join(root, directory); mkdirSync(owner); writeFileSync(join(owner, "SUBAGENTS.md"), "Owner"); writeFileSync(join(owner, "data"), "sentinel");
   const requested = `${input}/data`;
   assert.equal(resolveBuiltinTarget(root, requested, true), resolveReadPath(requested, root));
   assert.equal((await check({ toolName: "read", input: { path: requested } }, ctx))?.block, true);
   const result = await createReadTool(root).execute("read", { path: requested });
   assert.match(result.content[0].text, /sentinel/);
   assert.equal(resolveBuiltinTarget(root, requested), resolveToCwd(requested, root));
  }
  const url = pathToFileURL(join(root, "owned", "data")).href;
  assert.equal((await check({ toolName: "read", input: { path: url } }, ctx))?.block, true);
  assert.equal((await check({ toolName: "write", input: { path: "@owned/new" } }, ctx))?.block, true);
  // Spaces are literal: built-in normalization does not trim.
  assert.equal(resolveBuiltinTarget(root, " owned/new "), resolveToCwd(" owned/new ", root));
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("undiscovered direct owners, missing symlink suffixes, recursive scopes and trust denial", async () => {
 const root = mkdtempSync(join(tmpdir(), "pi-host-guard-"));
 const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => true };
 const check = guard();
 try {
  const owner = join(root, "node_modules", "hidden", "owner"); mkdirSync(owner, { recursive: true }); writeFileSync(join(owner, "SUBAGENTS.md"), "Owner");
  symlinkSync(owner, join(root, "alias"));
  symlinkSync(join(owner, "missing"), join(root, "dangling"));
  for (const target of [join(owner, "new"), "alias/missing/new", "dangling/new"]) assert.equal((await check({ toolName: "write", input: { path: target } }, ctx))?.block, true);
  const visible = join(root, "visible"); mkdirSync(visible); writeFileSync(join(visible, "SUBAGENTS.md"), "Owner");
  for (const toolName of ["grep", "find"]) {
   assert.equal((await check({ toolName, input: {} }, ctx))?.block, true);
   assert.equal((await check({ toolName, input: { path: "." } }, ctx))?.block, true);
  }
  assert.equal(await check({ toolName: "write", input: { path: "alias/new" } }, { ...ctx, isProjectTrusted: () => false }), undefined);
  const unowned = join(root, "plain"); mkdirSync(unowned);
  assert.equal(await check({ toolName: "grep", input: { path: "plain" } }, ctx), undefined);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
