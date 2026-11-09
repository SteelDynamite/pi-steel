import assert from "node:assert/strict";
import childProcess, { ChildProcess, type ExecFileException, type ExecFileOptions } from "node:child_process";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { executeControl } from "../control.js";

const root = "C:\\Program Files\\Paseo";
const wrapper = `${root}\\resources\\bin\\paseo.cmd`;
const app = `${root}\\Paseo.exe`;
const runner = `${root}\\resources\\app.asar.unpacked\\dist\\daemon\\node-entrypoint-runner.js`;
const archive = `${root}\\resources\\app.asar`;
const entry = `${archive}\\node_modules\\@getpaseo\\cli\\dist\\index.js`;
const env = {
  PASEO_HOOK_CLI: wrapper, PASEO_HOST: "wss://user:secret@example.invalid/?token=private",
  PASEO_AGENT_ID: "12345678-1234-4234-8234-123456789abc", PASEO_AUTH_TOKEN: "private-auth",
  ELECTRON_RUN_AS_NODE: "0", PASEO_NODE_ENV: "development", PASEO_DESKTOP_MANAGED: "0", PASEO_CLI: "old",
};
const text = (result: Awaited<ReturnType<typeof executeControl>>) => result.content[0].text;

// Windows path semantics and the complete execution boundary run on every OS.
function fixture(t: TestContext, error: ExecFileException | null = null, synchronous = false) {
  const files = new Set([wrapper, app, runner, archive]);
  const stat = t.mock.method(fs, "stat", (async (file: string) => {
    if (!files.has(file)) throw Object.assign(new Error(`secret path: ${file}`), { code: "ENOENT", syscall: "stat" });
    return { isFile: () => true } as Stats;
  }) as typeof fs.stat);
  const stdin = new PassThrough();
  const spawn = t.mock.method(childProcess, "execFile", ((
    _file: string, _args: string[], _options: ExecFileOptions,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => {
    if (synchronous) throw error;
    const child = new ChildProcess();
    child.stdin = stdin;
    queueMicrotask(() => {
      callback(error, "[]", "");
      child.emit("close", error ? 1 : 0);
    });
    return child;
  }) as typeof childProcess.execFile);
  return { files, stat, spawn, stdin };
}

test("Windows bundled launch mirrors the wrapper without a shell or environment mutation", async (t) => {
  const f = fixture(t);
  const before = { ...env };
  const controller = new AbortController();
  const workspaceId = "C:/Work/dt/dicethrone-unity-6000.1.11f";
  const prompt = '" & echo INJECTED | %PATH% !VAR! ^ < >\ntrailing\\';
  const result = await executeControl({ command: "run", workspaceId, provider: "pi", prompt }, controller.signal, root, env, "win32");
  assert.ok(!result.isError, text(result));
  assert.equal(f.spawn.mock.callCount(), 1);
  const [file, args, options] = f.spawn.mock.calls[0].arguments as unknown as [string, string[], ExecFileOptions];
  assert.equal(file, app);
  assert.deepEqual(args, [
    "--disable-warning=DEP0040", runner, "node-script", entry,
    `--host=${env.PASEO_HOST}`, "run", "--json", "--no-wait", "--env=PI_ORCHESTRATED_CHILD=1",
    `--workspace=${workspaceId}`, "--provider=pi", "--", prompt,
  ]);
  assert.deepEqual(options, {
    signal: controller.signal, cwd: root, shell: false, encoding: "utf8", timeout: 30000,
    maxBuffer: 1024 * 1024, killSignal: "SIGKILL",
    env: { ...env, ELECTRON_RUN_AS_NODE: "1", PASEO_NODE_ENV: "production", PASEO_DESKTOP_MANAGED: "1", PASEO_CLI: wrapper },
  });
  assert.deepEqual(env, before);
  assert.equal(f.stdin.writableEnded, true);
  assert.deepEqual(f.stat.mock.calls.map(call => call.arguments[0]), [wrapper, app, runner, archive]);
});

test("Windows native executables bypass wrapper adaptation and preserve inherited home", async (t) => {
  const f = fixture(t);
  const nativeEnv = { PASEO_HOOK_CLI: "C:\\tools\\paseo.exe", PASEO_HOME: "C:\\Paseo Home" };
  const result = await executeControl({ command: "ls" }, undefined, root, nativeEnv, "win32");
  assert.ok(!result.isError, text(result));
  const [file, args, options] = f.spawn.mock.calls[0].arguments as unknown as [string, string[], ExecFileOptions];
  assert.equal(file, nativeEnv.PASEO_HOOK_CLI);
  assert.deepEqual(args, ["--home=C:\\Paseo Home", "ls", "--global", "--json"]);
  assert.equal(options.env, nativeEnv);
  assert.equal(options.shell, false);
  assert.equal(f.stat.mock.callCount(), 0);
});

test("rejects unsupported, missing, or non-file Windows wrapper layouts without spawning", async (t) => {
  const f = fixture(t);
  for (const path of ["relative\\paseo.cmd", "\\resources\\bin\\paseo.cmd", "/resources/bin/paseo.cmd", "C:\\tools\\paseo.cmd", `${root}\\resources\\bin\\other.cmd`, wrapper.replace(/cmd$/, "bat")]) {
    const result = await executeControl({ command: "ls" }, undefined, root, { ...env, PASEO_HOOK_CLI: path }, "win32");
    assert.equal(result.isError, true);
  }
  for (const file of [...f.files]) {
    f.files.delete(file);
    const result = await executeControl({ command: "ls" }, undefined, root, env, "win32");
    assert.equal(result.isError, true);
    assert.match(text(result), /code ENOENT, syscall stat/);
    assert.doesNotMatch(text(result), /secret path|Program Files/);
    f.files.add(file);
  }
  f.stat.mock.mockImplementation((async (_file: string) => ({ isFile: () => false } as Stats)) as typeof fs.stat);
  assert.equal((await executeControl({ command: "ls" }, undefined, root, env, "win32")).isError, true);
  assert.equal(f.spawn.mock.callCount(), 0);
});

test("cancellation during Windows layout validation submits nothing", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  f.stat.mock.mockImplementation((async (_file: string) => {
    controller.abort();
    return { isFile: () => true } as Stats;
  }) as typeof fs.stat);
  const result = await executeControl({ command: "ls" }, controller.signal, root, env, "win32");
  assert.match(text(result), /nothing was submitted/);
  assert.equal(f.spawn.mock.callCount(), 0);
});

test("sync EINVAL and async ENOENT expose only safe diagnostic fields", async (t) => {
  for (const synchronous of [true, false]) {
    await t.test(synchronous ? "synchronous" : "callback", async (t) => {
      const code = synchronous ? "EINVAL" : "ENOENT";
      const error = Object.assign(new Error(`private invocation --host=${env.PASEO_HOST}`), {
        code, errno: -4071, syscall: `spawn ${wrapper}`, path: wrapper, spawnargs: ["secret-prompt"],
      });
      const f = fixture(t, error, synchronous);
      const result = await executeControl({ command: "send", agentId: env.PASEO_AGENT_ID, prompt: "secret-prompt" }, undefined, root, env, "win32");
      assert.equal(result.isError, true);
      assert.match(text(result), new RegExp(`code ${code}, errno -4071, syscall spawn`));
      assert.match(text(result), /outcome may be unknown/);
      assert.doesNotMatch(JSON.stringify(result), /private|secret|--host|Program Files|spawnargs/);
      assert.equal(f.spawn.mock.callCount(), 1);
    });
  }
});

test("malformed diagnostic fields cannot leak through errors", async (t) => {
  const error = Object.assign(new Error("private-message"), { code: "BAD --host=private", syscall: "private invocation", errno: "private" });
  fixture(t, error as unknown as ExecFileException, true);
  const result = await executeControl({ command: "ls" }, undefined, root, env, "win32");
  assert.equal(text(result), "Paseo execution failed.");
});

test("diagnostic fields still pass through environment-secret redaction", async (t) => {
  fixture(t, Object.assign(new Error("private"), { code: "ESECRET" }), true);
  const result = await executeControl({ command: "ls" }, undefined, root, { ...env, PASEO_AUTH_TOKEN: "ESECRET" }, "win32");
  assert.equal(text(result), "Paseo execution failed (code [REDACTED]).");
});
