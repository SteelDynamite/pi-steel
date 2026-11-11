import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ActivityReporter } from "../activity.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import { createRequire } from "node:module";
import { ActivityDiagnostics, DiagnosticStore as Store, diagnosticIdentity, diskWriter, supportsWriterRuntime, QUEUE_LIMIT, SLOT_BYTES, SLOT_COUNT } from "../diagnostics.js";

const stores = new Set<Store>();
class DiagnosticStore extends Store {
  constructor(...args: ConstructorParameters<typeof Store>) { super(...args); stores.add(this); }
}
afterEach(() => { for (const store of stores) store.close(); stores.clear(); });
function faultyWriter(inject: string) {
  return spawn(process.execPath, ["-e", `${inject}; (${diskWriter.toString()})()`], {
    detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: {},
  });
}

const run = promisify(execFile);
async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await delay(5);
  assert(check(), "diagnostic work did not settle");
}
function setup() {
  const home = mkdtempSync(join(tmpdir(), "paseo-diagnostics-"));
  const path = join(home, "private", "activity.v1.log");
  return { home, path, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
function records(path: string): Record<string, any>[] {
  const data = readFileSync(path);
  const result = [];
  for (let offset = 0; offset < data.length; offset += SLOT_BYTES) {
    const slot = data.subarray(offset, offset + SLOT_BYTES);
    if (slot.every(byte => byte === 0)) continue;
    try {
      const row = JSON.parse(slot.toString().trim());
      if (row.sha256 !== createHash("sha256").update(JSON.stringify(row.event)).digest("hex")) continue;
      result.push(row.event);
    } catch { /* Torn records are intentionally unreadable. */ }
  }
  return result;
}

class PausedWriter extends EventEmitter {
  sent: string[] = [];
  terminated = 0;
  connected = true;
  send(message: { record: string }) { this.sent.push(message.record); return true; }
  unref() { return this; }
  kill() { this.terminated++; return true; }
  disconnect() { this.connected = false; }
}

test("launch only a recognized plain Node interpreter; embedded/compiled runtimes fail closed", (t) => {
  const plain = { execPath: "/usr/bin/node", release: { name: "node" }, versions: { node: "22.0.0" } };
  assert(supportsWriterRuntime(plain));
  assert(supportsWriterRuntime({ ...plain, execPath: "C:\\Program Files\\nodejs\\node.exe" }));
  for (const runtime of [
    { ...plain, execPath: "/usr/bin/pi" }, { ...plain, execPath: "C:\\Pi\\pi.exe" },
    { ...plain, versions: { node: "22", electron: "30" } },
    { ...plain, versions: { node: "22", bun: "1" } },
    { ...plain, release: { name: "electron" } }, { ...plain, versions: {} },
    { ...plain, pkg: {} }, { ...plain, __nexe: {} },
  ]) assert.equal(supportsWriterRuntime(runtime), false);
  const sea = createRequire(import.meta.url)("node:sea");
  t.mock.method(sea, "isSea", () => true);
  assert.equal(supportsWriterRuntime(plain), false);
  const fixture = setup();
  try {
    const store = new DiagnosticStore(fixture.path);
    new ActivityDiagnostics(store).emit({ phase: "lifecycle" });
    assert.equal(store.failure, "unsupported_runtime");
    assert.equal(store.pending, 0);
    assert.equal(store.dropped, 1);
    assert(!existsSync(fixture.path), "no interpreter probe, helper, agent, or log file is launched");
  } finally { fixture.cleanup(); }
});

test("strict fields, hashed identities, bounded numeric values and no content leakage", async () => {
  const fixture = setup();
  try {
    const store = new DiagnosticStore(fixture.path);
    const diagnostics = new ActivityDiagnostics(store, "../../secret-terminal\n");
    diagnostics.emit({
      phase: "lifecycle", source: "session_start", reason: "startup", eligibility: "enabled", idle: true, waiting: false,
      request: Infinity, durationMs: -1, status: Number.MAX_VALUE,
      prompt: "SECRET", args: { token: "SECRET" }, error: "SECRET", url: "SECRET", title: "SECRET", path: "SECRET",
      outcome: "SECRET", call: "SECRET",
    } as any);
    await until(() => store.pending === 0);
    assert.equal(store.failure, undefined);
    const [event] = records(fixture.path);
    assert(event);
    assert.equal(event.terminal, diagnosticIdentity("../../secret-terminal\n"));
    assert.match(event.utc, /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.equal(event.status, Number.MAX_SAFE_INTEGER);
    assert.equal(event.request, undefined);
    assert.equal(event.durationMs, undefined);
    assert.deepEqual(Object.keys(event).sort(), ["dropped", "eligibility", "idle", "phase", "process", "reason", "runtime", "seq", "source", "status", "terminal", "utc", "v", "waiting"].sort());
    assert(!readFileSync(fixture.path).includes(Buffer.from("SECRET")));
    assert(!readFileSync(fixture.path).includes(Buffer.from(fixture.home)));
    if (process.platform !== "win32") {
      assert.equal(statSync(dirname(fixture.path)).mode & 0o777, 0o700);
      assert.equal(statSync(fixture.path).mode & 0o777, 0o600);
    }
    const before = store.written;
    diagnostics.close();
    diagnostics.emit({ phase: "lifecycle", source: "session_start" });
    assert.equal(store.written, before);
    assert.equal(store.pending, 0);
  } finally { fixture.cleanup(); }
});

test("bounded queue, rate limit, closed runtime and slow-writer circuit breaker", async () => {
  const worker = new PausedWriter();
  const store = new DiagnosticStore("unused", () => worker as unknown as ChildProcess);
  const diagnostics = new ActivityDiagnostics(store, "terminal");
  for (let i = 0; i < 10000; i++) diagnostics.emit({ phase: "lifecycle", source: "agent_start" });
  assert(store.pending <= QUEUE_LIMIT + 1);
  assert(store.dropped >= 10000 - QUEUE_LIMIT - 1);
  assert.equal(worker.sent.length, 1, "only one worker message may be outstanding");
  diagnostics.close();
  const dropped = store.dropped;
  diagnostics.emit({ phase: "lifecycle" });
  assert.equal(store.dropped, dropped);
  await until(() => store.failure === "write_deadline");
  assert.equal(store.pending, 0);
  assert.equal(worker.terminated, 1);
  assert.equal(worker.connected, false, "timeout disconnects IPC");
  store.close();
  assert.equal(worker.terminated, 1, "dispose is idempotent after a timeout");
  assert.match(diagnostics.status(), /disabled \(write_deadline\)/);
  worker.emit("message", "ok");
  const nextRuntime = new ActivityDiagnostics(store, "another-terminal");
  nextRuntime.emit({ phase: "lifecycle" });
  assert.equal(worker.sent.length, 1, "no retry or replacement after timeout, including later runtimes");
  assert.equal(store.written, 0);
});

test("blocked filesystem work does not block Pi's event loop or the 750ms HTTP deadline", async () => {
  const fixture = setup();
  const server = createServer(() => { /* Deterministic hung activity endpoint. */ });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    let workerExited = false;
    const store = new DiagnosticStore(fixture.path, () => faultyWriter(
      "require('node:fs').writeSync = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)",
    ).on("exit", () => { workerExited = true; }));
    const diagnostics = new ActivityDiagnostics(store);
    const reporter = new ActivityReporter({ url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/terminal-activity`), terminalId: "fixture", token: "fixture" }, diagnostics);
    const start = performance.now();
    const request = reporter.report("running");
    await delay(25);
    assert(performance.now() - start < 500, "main thread remains responsive during worker filesystem stall");
    await request;
    assert.match(reporter.error!, /unavailable or timed out/);
    assert(performance.now() - start < 2000, "HTTP still has its own deadline");
    diagnostics.close();
    await until(() => store.failure === "write_deadline");
    assert.equal(store.pending, 0);
    await until(() => workerExited);
  } finally { server.closeAllConnections(); server.close(); fixture.cleanup(); }
});

test("writer startup errors, hostile error messages and malformed replies remain nonfatal", () => {
  const store = new DiagnosticStore("unused", () => { throw new Error("SECRET"); });
  new ActivityDiagnostics(store).emit({ phase: "lifecycle" });
  assert.equal(store.failure, "writer");
  assert.equal(store.pending, 0);
  assert.equal(store.dropped, 1);
  const worker = new PausedWriter();
  const other = new DiagnosticStore("unused", () => worker as unknown as ChildProcess);
  const diagnostics = new ActivityDiagnostics(other);
  diagnostics.emit({ phase: "lifecycle" });
  worker.emit("message", { secret: "SECRET" });
  worker.emit("error", new Error("SECRET"));
  assert.equal(other.failure, "filesystem");
  assert(!diagnostics.status().includes("SECRET"));
});

test("real writer handles full disk, short writes and permissions without retrying", async () => {
  for (const failure of ["ENOSPC", "EACCES", "short"]) {
    const fixture = setup();
    try {
      const inject = failure === "short" ? "return 1" : `throw Object.assign(new Error('SECRET'), {code: '${failure}'})`;
      const store = new DiagnosticStore(fixture.path, () => faultyWriter(`require('node:fs').writeSync = () => { ${inject}; }`));
      const diagnostics = new ActivityDiagnostics(store);
      diagnostics.emit({ phase: "lifecycle" });
      await until(() => !!store.failure);
      assert.equal(store.failure, failure === "ENOSPC" ? "full" : failure === "EACCES" ? "permission" : "filesystem");
      assert.equal(store.dropped, 1);
      assert.equal(store.pending, 0);
      diagnostics.emit({ phase: "lifecycle" });
      assert.equal(store.dropped, 2);
      assert(!diagnostics.status().includes("SECRET"));
    } finally { fixture.cleanup(); }
  }
});

test("stale garbage stays bounded; oversized files, symlinks and public storage are refused", async () => {
  for (const mode of ["garbage", "oversized", "directory", ...(process.platform === "win32" ? [] : ["symlink", "public"])]) {
    const fixture = setup();
    try {
      mkdirSync(dirname(fixture.path), { mode: 0o700 });
      if (mode === "directory") mkdirSync(fixture.path);
      else if (mode === "symlink") symlinkSync(join(fixture.home, "target"), fixture.path);
      else writeFileSync(fixture.path, Buffer.alloc(mode === "oversized" ? SLOT_BYTES * SLOT_COUNT + 1 : SLOT_BYTES * SLOT_COUNT, 120), { mode: 0o600 });
      if (mode === "public") chmodSync(fixture.path, 0o644);
      const store = new DiagnosticStore(fixture.path);
      new ActivityDiagnostics(store).emit({ phase: "lifecycle" });
      await until(() => store.pending === 0);
      assert.equal(store.failure, mode === "garbage" ? undefined : "filesystem", mode);
      if (mode === "garbage") assert.equal(statSync(fixture.path).size, SLOT_BYTES * SLOT_COUNT);
      assert.deepEqual(readdirSync(dirname(fixture.path)), ["activity.v1.log"]);
      assert(!existsSync(join(fixture.home, "target")));
    } finally { fixture.cleanup(); }
  }
});

test("parent exits even if a blocked writer cannot be killed, with bounded fixture cleanup", { timeout: 15000 }, async () => {
  const fixture = setup();
  const fifo = join(fixture.home, "fifo");
  try {
    if (process.platform !== "win32") await run("mkfifo", [fifo], { timeout: 2000 });
    for (const mode of ["shutdown", "deadline", "dispose", "exit", "timeout"]) {
      let output = "";
      try {
        const result = await run(process.execPath, ["--import", "tsx", join(import.meta.dirname, "fixtures/diagnostics-shutdown.ts"), fixture.path, fifo, mode], {
          timeout: 5000, killSignal: "SIGKILL", env: { PATH: process.env.PATH, HOME: fixture.home, USERPROFILE: fixture.home },
        });
        output = result.stdout;
        assert.match(output, /blocked/);
        assert.match(output, /parent exiting/);
        if (mode === "dispose" || mode === "timeout") assert.match(output, /writer exited; IPC disconnected/);
        if (mode === "exit") {
          const pid = Number(/writer=(\d+)/.exec(output)?.[1]);
          assert(pid);
          await until(() => {
            try {
              process.kill(pid, 0);
              // An exited orphan can await the OS init process's reap on Linux.
              return process.platform === "linux" && /\)\s+Z\s/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
            } catch { return true; }
          });
        }
      } catch (error) {
        output = (error as { stdout?: string }).stdout ?? "";
        throw error;
      } finally {
        const pid = Number(/writer=(\d+)/.exec(output)?.[1]);
        if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      }
    }
  } finally { fixture.cleanup(); }
});

test("concurrent processes and repeated wraparound have one fixed total storage bound", { timeout: 30000 }, async () => {
  const fixture = setup();
  try {
    // A preexisting full extent simulates stale records after arbitrary crashes.
    mkdirSync(dirname(fixture.path), { mode: 0o700 });
    writeFileSync(fixture.path, Buffer.alloc(SLOT_BYTES * SLOT_COUNT), { mode: 0o600 });
    const script = join(import.meta.dirname, "fixtures/diagnostics-writer.ts");
    const outputs = await Promise.all([0, 1].map(n => run(process.execPath, ["--import", "tsx", script, fixture.path, String(n)], {
      timeout: 25000, env: { PATH: process.env.PATH, HOME: fixture.home, USERPROFILE: fixture.home },
    })));
    assert(outputs.every(result => result.stdout.includes("done")));
    assert.equal(statSync(fixture.path).size, SLOT_BYTES * SLOT_COUNT);
    assert.deepEqual(readdirSync(dirname(fixture.path)), ["activity.v1.log"], "no rotations, temp files, per-process files or locks");
    const rows = records(fixture.path);
    assert(rows.length > 100);
    assert.equal(new Set(rows.map(row => row.process)).size, 2);
    assert.equal(new Set(rows.map(row => row.runtime)).size, 2);
    assert.equal(new Set(rows.map(row => row.terminal)).size, 2);
    const result = await run(process.execPath, [join(import.meta.dirname, "../diagnostics-read.mjs"), fixture.path], { maxBuffer: SLOT_BYTES * SLOT_COUNT });
    assert.match(result.stderr, /valid records/);
    assert.equal(result.stdout.trim().split("\n").length, rows.length);
    // A torn overwrite must be rejected by the shipped reader.
    const data = readFileSync(fixture.path);
    const position = data.indexOf(Buffer.from('"lifecycle"'));
    assert(position >= 0);
    data[position + 1] = 88;
    writeFileSync(fixture.path, data);
    const torn = await run(process.execPath, [join(import.meta.dirname, "../diagnostics-read.mjs"), fixture.path], { maxBuffer: SLOT_BYTES * SLOT_COUNT });
    assert.equal(torn.stdout.trim().split("\n").length, rows.length - 1);
  } finally { fixture.cleanup(); }
});
