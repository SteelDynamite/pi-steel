import { request } from "node:http";
import type { ActivityDiagnostics, DiagnosticFields } from "./diagnostics.js";

type ActivityFacts = Pick<DiagnosticFields, "source" | "reason" | "idle" | "waiting" | "aborted">;

export type ActivityState = "running" | "idle" | "needs-input";
export interface ActivityConnection { url: URL; terminalId: string; token: string }

/** Only the injected, local capability endpoint is eligible. No DNS, proxies,
 * redirects, default ports, credential discovery, or remote token forwarding. */
export function activityConnection(env: NodeJS.ProcessEnv): ActivityConnection | undefined {
  if (!env.PASEO_TERMINAL_ID || !env.PASEO_ACTIVITY_TOKEN || !env.PASEO_TERMINAL_ACTIVITY_URL) return;
  try {
    const url = new URL(env.PASEO_TERMINAL_ACTIVITY_URL);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/api/terminal-activity") return;
    return { url, terminalId: env.PASEO_TERMINAL_ID, token: env.PASEO_ACTIVITY_TOKEN };
  } catch { return; }
}

/** One request in flight and one latest pending state. Pi's UI notifications
 * are not awaited; serializing them prevents a late `running` overwriting idle.
 * Coalescing bounds memory during a stalled daemon; intermediate states can drop. */
export class ActivityReporter {
  error: string | undefined;
  private pending: { state: ActivityState; request: number; facts: ActivityFacts } | undefined;
  private draining: Promise<void> | undefined;
  private sequence = 0;
  private inFlight: number | undefined;

  constructor(private readonly connection: ActivityConnection, private readonly diagnostics?: Pick<ActivityDiagnostics, "emit">) {}

  report(state: ActivityState, facts: ActivityFacts = {}): Promise<void> {
    const request = this.sequence = Math.min(Number.MAX_SAFE_INTEGER, this.sequence + 1);
    this.diagnostics?.emit({ ...facts, phase: "queued", state, request, replaced: this.pending?.request, inFlight: this.inFlight });
    this.pending = { state, request, facts };
    if (!this.draining) {
      this.draining = this.drain();
    }
    return this.draining;
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const { state, request: id, facts } = this.pending;
      this.pending = undefined;
      this.inFlight = id;
      const start = performance.now();
      this.diagnostics?.emit({ ...facts, phase: "request_start", state, request: id });
      await new Promise<void>((resolve) => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        let finished = false;
        const finish = (outcome: DiagnosticFields["outcome"], status?: number) => {
          if (finished) return;
          finished = true;
          clearTimeout(deadline);
          this.error = outcome === "ok" ? undefined : status !== undefined
            ? `Activity endpoint returned HTTP ${status}.` : "Activity endpoint unavailable or timed out.";
          this.diagnostics?.emit({ ...facts, phase: "request_end", state, request: id, outcome, status, durationMs: performance.now() - start });
          resolve();
        };
        try {
          const body = JSON.stringify({ terminalId: this.connection.terminalId, token: this.connection.token, state });
          const req = request(this.connection.url, {
            method: "POST", agent: false,
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          });
          // Preserve the total HTTP deadline, independent of diagnostic I/O.
          deadline = setTimeout(() => { timedOut = true; req.destroy(new Error("deadline")); }, 750);
          req.on("response", (res) => {
            finish(res.statusCode === 204 ? "ok" : "http", res.statusCode);
            res.destroy();
          });
          req.on("error", (error: NodeJS.ErrnoException) => {
            finish(timedOut ? "deadline" : error.code === "ECONNREFUSED" ? "refused" : error.code === "ECONNRESET" ? "reset" : "network");
          });
          req.end(body);
        } catch { finish("setup"); }
      });
      this.inFlight = undefined;
    }
    this.draining = undefined;
  }
}
