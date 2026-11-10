import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, promises as fs, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { useFakePi } from "./fixtures/pi-host.mjs";
import { runDelegation } from "../execution.ts";
import { SubagentParams } from "../schema.ts";
import { getResultOutput } from "../result.ts";
import { trackedSessions } from "../state.ts";
import { renderSubagentCall, renderSubagentResult } from "../render.ts";

const target = "openrouter/anthropic/claude-fable-5.2";
const details = (results) => ({ results, includeLocationalAgents: false, locationalAgents: [] });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-one-off-"));
  const script = join(root, "pi.cjs");
  const restorePi = useFakePi(root, script);
  const state = join(root, "calls.json");
  writeFileSync(state, "[]");
  writeFileSync(script, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const promptPath = at('--append-system-prompt');
const guardPath = at('--extension');
const calls = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
calls.push({ args, cwd: process.cwd(), promptPath, guardPath, guardMode: guardPath && (fs.statSync(guardPath).mode & 0o777), prompt: promptPath && fs.readFileSync(promptPath, 'utf8'),
  mode: promptPath && (fs.statSync(promptPath).mode & 0o777), child: process.env.PI_ORCHESTRATED_CHILD,
  advertise: process.env.PI_SUBAGENT_ADVERTISE_LOCATIONAL_AGENTS });
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(calls));
if (args.at(-1) === 'Task: fail') { console.error('model unavailable'); process.exit(1); }
console.log(JSON.stringify({type: 'message_end', message: {role: 'assistant', content: [{type: 'text', text: 'done'}], stopReason: 'stop'}}));
if (args.at(-1) === 'Task: wait') setInterval(() => {}, 1000);
`);
  const role = { id: "reviewer", description: "Review", origin: "bundled", kind: "behavioral", manifest: true,
    resumable: true, filePath: join(root, "SUBAGENTS.md"), rootDir: root, systemPrompt: "Keep the role instructions.",
    tools: ["read", "bash"], model: "test/base", thinking: "low",
    whenCallerModelId: "gpt-6-astra", thenModel: "test/conditional", thenThinking: "xhigh" };
  const ctx = { cwd: root, isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "one-off-parent", getBranch: () => [] },
    model: { provider: "openai", id: "gpt-6-astra", contextWindow: 1000 },
    modelRegistry: { getAvailable: () => [
      { provider: "openrouter", id: "anthropic/claude-fable-5.2", contextWindow: 1000000 },
      { provider: "test", id: "conditional", contextWindow: 2000 },
    ] } };
  return { root, state, role, ctx,
    calls: () => JSON.parse(readFileSync(state, "utf8")),
    run: (configuration, { id = "reviewer", session = "new", task = "work", signal, update, include = false, agents = [role] } = {}) =>
      runDelegation({ appendEntry() { assert.fail("One-off state must not be persisted"); } }, ctx, root, agents, id, session, task, signal, update, details, include, undefined, configuration),
    close() { restorePi(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("one-off schema keeps the root object and rejects malformed configurations", () => {
  assert.equal(SubagentParams.type, "object");
  const input = { id: "reviewer", session: "new", task: "Audit" };
  for (const config of [
    { overrides: { model: target, thinking: "high", tools: ["read"] } },
    { custom: { instructions: "Review", tools: [] } },
    { overrides: { tools: [] } },
  ]) assert(Value.Check(SubagentParams, { ...input, ...config }));
  for (const config of [
    { overrides: {} }, { overrides: { model: "bare" } }, { overrides: { model: "test/a,test/b" } },
    { overrides: { model: " test/a" } }, { overrides: { model: "test/*" } },
    { overrides: { thinking: "highest" } }, { overrides: { instructions: "replace role" } },
    { overrides: { tools: ["read", "read"] } }, { overrides: { tools: [""] } },
    { custom: {} }, { custom: { instructions: " \n " } }, { custom: { instructions: "Review", cwd: "/tmp" } },
    { custom: null }, { overrides: null },
  ]) assert(!Value.Check(SubagentParams, { ...input, ...config }), JSON.stringify(config));
});

test("overrides win after conditional policy, retain instructions, and leave reusable state untouched", async () => {
  const f = fixture();
  const saved = { mainSessionKey: "one-off-parent", agentId: "reviewer", sessionId: "existing", nextIntent: "resume", reason: "under-threshold" };
  const key = "one-off-parent\0reviewer";
  const previous = trackedSessions.get(key);
  trackedSessions.set(key, saved);
  try {
    const definition = structuredClone(f.role);
    const updates = [];
    const result = await f.run({ overrides: { model: target, thinking: "high", tools: ["read"] } }, { update: value => updates.push(value.details.results[0].configuration) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.model, target);
    assert.equal(result.agentThinking, "high");
    assert.equal(result.configuration, "overrides");
    assert.deepEqual(result.agentTools, ["read"]);
    assert.equal(result.agentOrigin, "bundled");
    assert.equal(result.nextSessionIntent, undefined);
    assert.match(getResultOutput(result), /One-off overrides: openrouter\/anthropic\/claude-fable-5\.2; thinking: high; tools: read/);
    assert.deepEqual(f.role, definition);
    assert.equal(trackedSessions.get(key), saved);
    assert(updates.length > 0 && updates.every(value => value === "overrides"));
    const [call] = f.calls();
    assert.equal(call.cwd, f.root);
    assert.equal(call.prompt, f.role.systemPrompt);
    assert.equal(call.mode, 0o600);
    assert.equal(call.guardMode, 0o600);
    assert(!existsSync(call.guardPath));
    assert.equal(call.child, "1");
    assert(call.args.includes("--no-session") && call.args.includes("--no-approve"));
    assert(!call.args.includes("--session-id"));
    assert.equal(call.args[call.args.indexOf("--model") + 1], target);
    assert.equal(call.args[call.args.indexOf("--thinking") + 1], "high");
    assert.equal(call.args[call.args.indexOf("--tools") + 1], "read");
    assert(!existsSync(dirname(call.promptPath)));

    const inherited = await f.run({ overrides: { tools: [] } });
    assert.equal(inherited.model, "test/conditional");
    assert.equal(inherited.agentThinking, "xhigh");
    assert.deepEqual(inherited.agentTools, []);
    assert(f.calls()[1].args.includes("--no-tools"));
    assert(!f.calls()[1].args.includes("--tools"));
  } finally {
    if (previous) trackedSessions.set(key, previous); else trackedSessions.delete(key);
    f.close();
  }
});

test("inline agents use literal instructions, caller defaults, and no definition file", async () => {
  const f = fixture();
  try {
    const instructions = "Review the source.\n@do-not-expand.md\n<literal>keep this</literal>";
    const result = await f.run({ custom: { instructions } }, { id: "audit-once" });
    assert.equal(result.agentOrigin, "custom");
    assert.equal(result.configuration, "custom");
    assert.equal(result.model, "openai/gpt-6-astra");
    assert.equal(result.agentThinking, undefined);
    assert.equal(result.agentTools, undefined);
    assert.equal(f.calls()[0].prompt, instructions);
    assert(!f.calls()[0].args.includes("--tools"));
    assert(!existsSync(join(f.root, "audit-once")));
    assert(!existsSync(dirname(f.calls()[0].promptPath)));
  } finally { f.close(); }
});

test("bad one-off modes, identities, models, tools and resume attempts fail before spawn", async () => {
  const f = fixture();
  const previousOptIn = process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS;
  try {
    process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS = "1";
    mkdirSync(join(f.root, "owned"));
    writeFileSync(join(f.root, "owned", "SUBAGENTS.md"), "---\ndescription: owned\n---\nOwner");
    const cases = [
      [{ overrides: { thinking: "high" }, custom: { instructions: "Audit" } }, {}, /mutually exclusive/],
      [{ overrides: { thinking: "high" } }, { session: "resume" }, /cannot be resumed/],
      [{ custom: { instructions: "Audit" } }, { id: "new-role", session: "resume" }, /cannot be resumed/],
      [{ overrides: {} }, {}, /Invalid overrides/],
      [{ custom: { instructions: " " } }, { id: "new-role" }, /Invalid custom/],
      [{ custom: { instructions: "Audit" } }, {}, /collides/],
      [{ custom: { instructions: "Audit" } }, { id: "../elsewhere" }, /kebab-case/],
      [{ custom: { instructions: "Audit" } }, { id: "owned" }, /collides/],
      [{ overrides: { thinking: "high" } }, { id: "owned" }, /behavioral-only/],
      [{ overrides: { thinking: "high" } }, { id: "missing" }, /Unknown subagent/],
      [{ overrides: { model: "other/anthropic/claude-fable-5.2" } }, {}, /no fallback/],
      [{ overrides: { model: "anthropic/claude-fable-5.2:high" } }, {}, /no fallback/],
      [{ overrides: { tools: ["unknown"] } }, {}, /unknown tool/],
      [{ overrides: { tools: ["+read"] } }, {}, /unknown tool/],
      [{ custom: { instructions: "Audit", tools: ["read,*"] } }, { id: "new-role" }, /unknown tool/],
    ];
    for (const [configuration, options, error] of cases) {
      const result = await f.run(configuration, options);
      assert.equal(result.exitCode, 1, JSON.stringify(configuration));
      assert.match(result.stderr, error);
    }
    assert.deepEqual(f.calls(), []);
  } finally {
    if (previousOptIn === undefined) delete process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS;
    else process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS = previousOptIn;
    f.close();
  }
});

test("one-off failures never retry and cancellation retains prompt cleanup", async () => {
  const f = fixture();
  try {
    const configuration = { custom: { instructions: "Audit", model: target, tools: [] } };
    const failed = await f.run(configuration, { id: "audit-once", task: "fail" });
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.model, target);
    assert.equal(f.calls().length, 1);
    assert(!existsSync(dirname(f.calls()[0].promptPath)));
    const controller = new AbortController();
    const aborted = await f.run(configuration, { id: "audit-once", task: "wait", signal: controller.signal, update: () => controller.abort() });
    assert.equal(aborted.stopReason, "aborted");
    assert.equal(aborted.exitCode, 130);
    assert.equal(f.calls().length, 2);
    assert(!existsSync(dirname(f.calls()[1].promptPath)));
  } finally { f.close(); }
});

test("one-offs retain recursion and default-off advertising guards", async () => {
  const f = fixture();
  const names = ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS"];
  const before = names.map(name => process.env[name]);
  try {
    process.env.PI_SUBAGENT_DEPTH = "5";
    const result = await f.run({ custom: { instructions: "Audit" } }, { id: "inline-audit" });
    assert.match(result.stderr, /recursion limit/);
    assert.deepEqual(f.calls(), []);
    delete process.env.PI_SUBAGENT_DEPTH;
    delete process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS;
    const completed = await f.run({ custom: { instructions: "Audit" } }, { id: "inline-audit", include: true });
    assert.equal(completed.exitCode, 0);
    assert.equal(f.calls()[0].advertise, "0");
  } finally {
    names.forEach((name, index) => { if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index]; });
    f.close();
  }
});

test("startup guard write failure cleans the private prompt directory before returning", async () => {
  const f = fixture();
  const write = fs.writeFile;
  let directory;
  try {
    fs.writeFile = async (path, ...args) => {
      if (String(path).endsWith("exact-model.mjs")) { directory = dirname(path); throw new Error("guard write failure"); }
      return write(path, ...args);
    };
    const result = await f.run({ custom: { instructions: "Audit" } }, { id: "inline-audit" });
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage, /guard write failure/);
    assert(directory && !existsSync(directory));
    assert.deepEqual(f.calls(), []);
  } finally { fs.writeFile = write; f.close(); }
});

test("one-off configuration is visible in calls and both historical result views", async () => {
  const f = fixture();
  const theme = { fg: (_color, text) => text, bold: text => text };
  try {
    for (const configuration of [{ overrides: { tools: [] } }, { custom: { instructions: "Audit", model: target, tools: ["read"] } }]) {
      const id = configuration.custom ? "audit-once" : "reviewer";
      const result = await f.run(configuration, { id });
      const call = renderSubagentCall({ id, session: "new", task: "Audit", ...configuration }, theme, {}).render(200).join("\n");
      assert.match(call, new RegExp(`one-off:${result.configuration}`));
      for (const expanded of [false, true]) {
        const historical = JSON.parse(JSON.stringify(result));
        const view = renderSubagentResult({ details: details([historical]) }, { expanded }, theme, {}).render(200).join("\n");
        assert(view.includes(result.model));
        assert.match(view, new RegExp(`One-off ${result.configuration} · tools: ${configuration.custom ? "read" : "none"}`));
      }
    }
  } finally { f.close(); }
});
