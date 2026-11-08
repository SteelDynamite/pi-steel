import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { controlSchema, executeControl, type ControlInput } from "../control.js";

const id = "12345678-1234-4234-8234-123456789abc";
const workspaceId = "wks_0123456789abcdef";
const text = (result: Awaited<ReturnType<typeof executeControl>>) => result.content[0].text;

// No daemon/provider: a real executable checks argv, env, EOF and process limits.
async function fixture(t: TestContext, mode = "argv") {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-control-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const executable = join(cwd, "fake paseo");
  const script = join(cwd, "fake.cjs");
  await writeFile(script, `
const fs = require('node:fs');
fs.appendFileSync('calls', '1');
process.stdin.resume();
process.stdin.on('end', () => {
  if (process.env.MODE === 'argv') console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), agent: process.env.PASEO_AGENT_ID, marker: process.env.INHERITED_MARKER }));
  if (process.env.MODE === 'fail') { console.log(process.env.UNSAFE); console.error(process.env.UNSAFE); process.exitCode = 7; }
  if (process.env.MODE === 'bytes') console.log('x'.repeat(60000));
  if (process.env.MODE === 'lines') console.log('line\\n'.repeat(2500));
  if (process.env.MODE === 'stdout' || process.env.MODE === 'stderr') { process[process.env.MODE].write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000); }
  if (process.env.MODE === 'hang') { process.on('SIGTERM', () => {}); fs.writeFileSync('ready', String(process.pid)); setInterval(() => {}, 1000); }
});
`);
  // exec replaces the wrapper, so cancellation tests exercise the actual child.
  await writeFile(executable, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`);
  await chmod(executable, 0o700);
  const env = { ...process.env, PASEO_HOST: undefined, PASEO_HOME: "/isolated/paseo", PASEO_HOOK_CLI: executable, PASEO_AGENT_ID: id, INHERITED_MARKER: "preserved", MODE: mode };
  return { cwd, env, call: (input: ControlInput, signal?: AbortSignal) => executeControl(input, signal, cwd, env) };
}

async function ready(cwd: string) {
  for (let i = 0; i < 200; i++) {
    try { return Number(await readFile(join(cwd, "ready"), "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error("Fake CLI did not start within two seconds");
}

async function exited(pid: number) {
  for (let i = 0; i < 200; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Fake CLI remained alive after cancellation/timeout");
}

test("schema is one strict root object with required command only", () => {
  assert.equal(controlSchema.type, "object");
  assert.deepEqual(controlSchema.required, ["command"]);
  const schema = JSON.parse(JSON.stringify(controlSchema));
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.command.enum.includes("run"));
});

test("supported commands preserve argv, cwd, environment and close stdin without a shell", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const cases: [ControlInput, string[]][] = [
    [{ command: "ls" }, ["ls", "--global", "--json"]],
    [{ command: "inspect", agentId: id }, ["inspect", "--json", "--", id]],
    [{ command: "run", workspaceId, provider: "codex", prompt: "--host=evil; $(echo bad)" }, ["run", "--json", "--no-wait", "--env=PI_ORCHESTRATED_CHILD=1", `--workspace=${workspaceId}`, "--provider=codex", "--", "--host=evil; $(echo bad)"]],
    [{ command: "send", agentId: id, prompt: "follow up" }, ["send", "--json", "--no-wait", "--behavior=steer", "--prompt=follow up", "--", id]],
    [{ command: "stop", agentId: id }, ["stop", "--json", "--", id]],
    [{ command: "workspace ls" }, ["workspace", "ls", "--json"]],
    [{ command: "provider ls" }, ["provider", "ls", "--json"]],
    [{ command: "terminal ls" }, ["terminal", "ls", "--all", "--json"]],
    [{ command: "terminal create", workspaceId, name: "--help" }, ["terminal", "create", "--json", `--workspace=${workspaceId}`, "--name=--help"]],
    [{ command: "terminal capture", terminalId: id }, ["terminal", "capture", "--json", "--", id]],
    [{ command: "terminal send-keys", terminalId: id, keys: ["--host=evil", "text"], literal: true }, ["terminal", "send-keys", "--json", "--literal", "--", id, "--host=evil", "text"]],
    [{ command: "terminal send-keys", terminalId: id, keys: ["Enter"], literal: false }, ["terminal", "send-keys", "--json", "--", id, "Enter"]],
    [{ command: "terminal kill", terminalId: id }, ["terminal", "kill", "--json", "--", id]],
  ];
  for (const [input, args] of cases) {
    const result = await f.call(input);
    assert.ok(!result.isError, text(result));
    assert.deepEqual(JSON.parse(text(result).split("\n")[1]), { args: ["--home=/isolated/paseo", ...args], cwd: f.cwd, agent: id, marker: "preserved" });
  }
});

test("rejects invalid inputs/targets and pre-canceled requests without spawning", async (t) => {
  const f = await fixture(t);
  const bad = [
    {}, { command: "daemon start" }, { command: "ls", host: "evil" },
    { command: "ls", prompt: undefined }, { command: "run", prompt: "task" },
    { command: "stop", agentId: "1234567" }, { command: "stop", agentId: "--all" },
    { command: "inspect", agentId: "named-agent" }, { command: "send", agentId: id, prompt: "\0" },
    { command: "terminal create", workspaceId: "prefix", name: "shell" },
    { command: "terminal create", workspaceId: id, name: "shell" },
    { command: "terminal send-keys", terminalId: id, keys: ["Enter"] },
    { command: "terminal send-keys", terminalId: id, keys: [], literal: true },
    { command: "terminal send-keys", terminalId: id, keys: [42], literal: true },
  ];
  for (const input of bad) assert.equal((await f.call(input as ControlInput)).isError, true);
  for (const target of [
    { PASEO_HOME: undefined }, { PASEO_HOST: "a", PASEO_HOME: "b" },
    { PASEO_HOME: " " }, { PASEO_HOOK_CLI: "relative/paseo" },
  ]) assert.equal((await executeControl({ command: "ls" }, undefined, f.cwd, { ...f.env, ...target })).isError, true);
  const controller = new AbortController();
  controller.abort();
  assert.match(text(await f.call({ command: "stop", agentId: id }, controller.signal)), /nothing was submitted/);
  await assert.rejects(readFile(join(f.cwd, "calls")), { code: "ENOENT" });
});

test("sanitizes stdout/stderr and never includes credential-bearing invocation errors", async (t) => {
  const f = await fixture(t, "fail");
  const env = { ...f.env, PASEO_HOME: undefined, PASEO_HOST: "wss://user:pass@host/?token=abc", OPENAI_API_KEY: "private-value", UNSAFE: "" };
  env.UNSAFE = `${env.PASEO_HOST} private-value https://other:password@host/?password=another`;
  for (const overrides of [{}, { PASEO_HOOK_CLI: join(f.cwd, "missing-private-value") }]) {
    const result = await executeControl({ command: "send", agentId: id, prompt: "prompt-not-for-errors" }, undefined, f.cwd, { ...env, ...overrides });
    assert.equal(result.isError, true);
    assert.match(text(result), /outcome may be unknown/);
    assert.doesNotMatch(JSON.stringify(result), /private-value|user:pass|other:password|=another|token=abc|prompt-not-for-errors|--host/);
    if (!Object.keys(overrides).length) assert.match(text(result), /exit 7/);
  }
});

test("caps each stream at 1 MiB and does not retry mutations", { timeout: 10000 }, async (t) => {
  for (const stream of ["stdout", "stderr"]) {
    const f = await fixture(t, stream);
    const result = await f.call({ command: "stop", agentId: id });
    assert.equal(result.isError, true);
    assert.match(text(result), /Capture truncated at 1 MiB per stream/);
    assert.match(text(result), /outcome may be unknown/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 53000);
    assert.equal(await readFile(join(f.cwd, "calls"), "utf8"), "1");
  }
});

test("cancellation kills a SIGTERM-resistant child", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, "hang");
  const controller = new AbortController();
  const pending = f.call({ command: "stop", agentId: id }, controller.signal);
  const pid = await ready(f.cwd);
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(text(result), /CLI canceled.*outcome may be unknown/);
  await exited(pid);
});

test("30-second timeout hard-kills a SIGTERM-resistant child", { timeout: 40000 }, async (t) => {
  const f = await fixture(t, "hang");
  const start = Date.now();
  const pending = f.call({ command: "stop", agentId: id });
  const pid = await ready(f.cwd);
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(text(result), /timed out or terminated.*outcome may be unknown/);
  assert.ok(Date.now() - start >= 29000);
  assert.ok(Date.now() - start < 36000);
  await exited(pid);
});

test("limits display bytes/lines without an unredacted details copy", async (t) => {
  for (const mode of ["bytes", "lines"]) {
    const f = await fixture(t, mode);
    const result = await f.call({ command: "ls" });
    assert.equal(result.details.truncated, true);
    assert.match(text(result), /remainder discarded/);
    assert.ok(Buffer.byteLength(text(result)) < 52000);
    assert.equal(Object.hasOwn(result.details, "stdout"), false);
  }
});
