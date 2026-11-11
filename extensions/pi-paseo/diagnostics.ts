import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";

export const SLOT_BYTES = 1024;
export const SLOT_COUNT = 4096;
export const QUEUE_LIMIT = 64;
export const WRITE_DEADLINE_MS = 1000;
const COUNTER_MAX = Number.MAX_SAFE_INTEGER;
const increment = (n: number, by = 1) => Math.min(COUNTER_MAX, n + by);

export interface DiagnosticFields {
  phase: "lifecycle" | "queued" | "request_start" | "request_end" | "subagent_start" | "subagent_end";
  source?: "session_start" | "session_shutdown" | "before_agent_start" | "agent_start" | "agent_end" | "agent_settled" | "ui_prompt_start" | "ui_prompt_end";
  state?: "running" | "idle" | "needs-input";
  reason?: "startup" | "reload" | "new" | "resume" | "fork" | "quit";
  eligibility?: "enabled" | "non_tui" | "outside_paseo" | "invalid_connection";
  outcome?: "ok" | "http" | "deadline" | "refused" | "reset" | "network" | "setup";
  idle?: boolean;
  waiting?: boolean;
  aborted?: boolean;
  isError?: boolean;
  request?: number;
  replaced?: number;
  inFlight?: number;
  status?: number;
  durationMs?: number;
  call?: string;
}

/** Hash only bounded identity inputs, never prompts, arguments, or event objects. */
export function diagnosticIdentity(value: string): string {
  return createHash("sha256").update(value.length <= 4096 ? value : "oversized-identity").digest("hex");
}

// Self-contained CommonJS child body: no host imports, closures, transpiled
// helpers, async filesystem pool jobs, append, truncate, rename, or lock files.
export function diskWriter() {
  const fs = require("node:fs") as typeof import("node:fs");
  const { dirname } = require("node:path") as typeof import("node:path");
  const { randomInt } = require("node:crypto") as typeof import("node:crypto");
  let slot: number | undefined;
  process.on("disconnect", () => process.exit());
  process.on("message", (message) => {
    const { path, bytes, slots, record } = message as unknown as { path: string; bytes: number; slots: number; record: string };
    slot ??= randomInt(slots);
    let fd: number | undefined;
    let result = "ok";
    try {
      const directory = dirname(path);
      try { fs.mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const dir = fs.lstatSync(directory);
      if (!dir.isDirectory() || dir.isSymbolicLink()
        || (process.platform !== "win32" && ((dir.mode & 0o077) !== 0 || dir.uid !== process.getuid!()))) throw new Error();
      // O_NONBLOCK also keeps a replaced FIFO from blocking on POSIX. Windows
      // does not offer O_NOFOLLOW; the private parent and lstat are essential.
      try {
        const before = fs.lstatSync(path);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0), 0o600);
      const file = fs.fstatSync(fd);
      if (!file.isFile() || file.nlink !== 1 || file.size > bytes * slots
        || (process.platform !== "win32" && ((file.mode & 0o077) !== 0 || file.uid !== process.getuid!()))) throw new Error();
      if (typeof record !== "string" || Buffer.byteLength(record) !== bytes) throw new Error();
      const buffer = Buffer.from(record);
      // One positional write only. Short/torn writes are loss, never retried.
      if (fs.writeSync(fd, buffer, 0, bytes, slot * bytes) !== bytes) throw new Error();
      slot = (slot + 1) % slots;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      result = code === "ENOSPC" || code === "EDQUOT" ? "full"
        : code === "EACCES" || code === "EPERM" ? "permission" : "filesystem";
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { result = "filesystem"; }
      }
    }
    if (process.connected) process.send!(result);
  });
}

type Writer = Pick<ChildProcess, "on" | "send" | "unref" | "kill" | "disconnect" | "connected" | "channel">;

/** Conservative interpreter contract: never probe by executing an unknown Pi,
 * Electron, Bun, SEA, or packaged binary with JavaScript as an argument. */
export function supportsWriterRuntime(runtime: {
  execPath: string; release: { name: string }; versions: { node?: string; electron?: string; bun?: string };
} = process): boolean {
  if (!/(^|[/\\])node(?:\.exe)?$/i.test(runtime.execPath) || runtime.release.name !== "node"
    || !runtime.versions.node || runtime.versions.electron || runtime.versions.bun
    || "pkg" in runtime || "__nexe" in runtime) return false;
  try { return createRequire(import.meta.url)("node:sea").isSea() === false; }
  catch { return false; }
}

/** One process-owned writer, shared across reloads. No session callbacks or
 * objects are retained in its bounded queue. A failure disables it for the
 * process lifetime; even a wedged child is never replaced with another. */
export class DiagnosticStore {
  readonly processId = randomUUID();
  written = 0;
  dropped = 0;
  failure: string | undefined;
  private queue: string[] = [];
  private writer: Writer | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private tokens = QUEUE_LIMIT;
  private refill = performance.now();

  constructor(readonly path: string, private readonly makeWriter: () => Writer | undefined = () => {
    if (!supportsWriterRuntime()) return;
    return spawn(process.execPath,
      ["--max-old-space-size=16", "--max-semi-space-size=2", "--stack-size=1024", "-e", `(${diskWriter.toString()})()`],
      { detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: {} },
    );
  }) {}

  // An OS-blocked thread can hold Node's exit join forever. A detached process
  // with unreferenced IPC lets Pi exit without waiting for the kernel to cancel
  // the write. Only our own child receives this single kill request.
  private stop = () => {
    process.off("exit", this.stop);
    try { if (this.writer?.connected) this.writer.disconnect(); } catch { /* best effort */ }
    try { this.writer?.kill("SIGKILL"); } catch { /* best effort */ }
  };

  close() { this.fail("closed"); }

  get pending(): number { return this.queue.length + (this.deadline ? 1 : 0); }

  private fail(reason: string) {
    if (this.failure) return;
    this.failure = reason;
    this.dropped = increment(this.dropped, this.pending);
    this.queue = [];
    clearTimeout(this.deadline);
    this.deadline = undefined;
    // Never await OS/filesystem cleanup from a lifecycle or model/tool hook.
    this.stop();
  }

  submit(record: string) {
    const now = performance.now();
    this.tokens = Math.min(QUEUE_LIMIT, this.tokens + Math.max(0, now - this.refill) * 32 / 1000);
    this.refill = now;
    if (this.failure || this.tokens < 1 || this.queue.length >= QUEUE_LIMIT || Buffer.byteLength(record) !== SLOT_BYTES) {
      this.dropped = increment(this.dropped);
      return;
    }
    this.tokens--;
    this.queue.push(record);
    this.drain();
  }

  private drain() {
    if (this.deadline || this.failure || !this.queue.length) return;
    try {
      if (!this.writer) {
        this.writer = this.makeWriter();
        if (!this.writer) { this.fail("unsupported_runtime"); return; }
        process.once("exit", this.stop);
        this.writer.on("error", () => this.fail("writer"));
        this.writer.on("exit", () => this.fail("writer_exit"));
        this.writer.on("message", (result: unknown) => {
          if (this.failure || !this.deadline) return;
          if (result !== "ok") {
            this.fail(result === "full" || result === "permission" ? result : "filesystem");
            return;
          }
          clearTimeout(this.deadline);
          this.deadline = undefined;
          this.written = increment(this.written);
          this.drain();
        });
        this.writer.unref();
        this.writer.channel?.unref();
      }
      this.deadline = setTimeout(() => this.fail("write_deadline"), WRITE_DEADLINE_MS);
      this.deadline.unref();
      this.writer.send({ path: this.path, bytes: SLOT_BYTES, slots: SLOT_COUNT, record: this.queue.shift()! }, error => {
        if (error) this.fail("writer");
      });
    } catch { this.fail("writer"); }
  }
}

/** Runtime-scoped metadata and strict runtime field allowlist. */
export class ActivityDiagnostics {
  readonly runtime = randomUUID();
  readonly terminal: string | undefined;
  private sequence = 0;
  private closed = false;

  constructor(readonly store: DiagnosticStore, terminalId?: string) {
    this.terminal = terminalId ? diagnosticIdentity(terminalId) : undefined;
  }

  emit(fields: DiagnosticFields) {
    if (this.closed) return;
    try {
      this.sequence = increment(this.sequence);
      const event: Record<string, unknown> = {
        v: 1, utc: new Date().toISOString(), process: this.store.processId,
        runtime: this.runtime, terminal: this.terminal, seq: this.sequence,
        dropped: this.store.dropped,
      };
      const enums = {
        phase: ["lifecycle", "queued", "request_start", "request_end", "subagent_start", "subagent_end"],
        source: ["session_start", "session_shutdown", "before_agent_start", "agent_start", "agent_end", "agent_settled", "ui_prompt_start", "ui_prompt_end"],
        state: ["running", "idle", "needs-input"],
        reason: ["startup", "reload", "new", "resume", "fork", "quit"],
        eligibility: ["enabled", "non_tui", "outside_paseo", "invalid_connection"],
        outcome: ["ok", "http", "deadline", "refused", "reset", "network", "setup"],
      };
      for (const key of Object.keys(enums) as Array<keyof typeof enums>) {
        const value = fields[key];
        if (typeof value === "string" && enums[key].includes(value)) event[key] = value;
      }
      for (const key of ["idle", "waiting", "aborted", "isError"] as const) {
        if (typeof fields[key] === "boolean") event[key] = fields[key];
      }
      for (const key of ["request", "replaced", "inFlight", "status", "durationMs"] as const) {
        const value = fields[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) event[key] = Math.min(COUNTER_MAX, Math.floor(value));
      }
      if (typeof fields.call === "string" && /^[a-f0-9]{64}$/.test(fields.call)) event.call = fields.call;
      const payload = JSON.stringify(event);
      const record = JSON.stringify({ sha256: diagnosticIdentity(payload), event });
      if (Buffer.byteLength(record) >= SLOT_BYTES) { this.store.dropped = increment(this.store.dropped); return; }
      this.store.submit(record.padEnd(SLOT_BYTES - 1, " ") + "\n");
    } catch { this.store.dropped = increment(this.store.dropped); }
  }

  close() { this.closed = true; }

  status(): string {
    return `Diagnostics: ${this.store.failure ? `disabled (${this.store.failure})` : "on (best effort)"}; written=${this.store.written}, dropped=${this.store.dropped}, pending=${this.store.pending} (process counters).\nDiagnostics file: ${this.store.path}\nTerminal hash: ${this.terminal ?? "none"}; runtime: ${this.runtime}`;
  }
}

export function createDiagnostics(terminalId?: string): ActivityDiagnostics {
  // Not keyed by agent-dir, project, session, or package checkout: all runtimes
  // in this process and all processes with this home share one bounded store.
  const key = Symbol.for("pi-steel.paseo.diagnostics.v1");
  const shared = globalThis as unknown as Record<symbol, DiagnosticStore>;
  const store = shared[key] ??= new DiagnosticStore(join(homedir(), ".pi-paseo-diagnostics", "activity.v1.log"));
  return new ActivityDiagnostics(store, terminalId);
}
