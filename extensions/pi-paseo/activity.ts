import { request } from "node:http";

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
  private pending: ActivityState | undefined;
  private draining: Promise<void> | undefined;

  constructor(private readonly connection: ActivityConnection) {}

  report(state: ActivityState): Promise<void> {
    this.pending = state;
    if (!this.draining) {
      this.draining = this.drain();
    }
    return this.draining;
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const state = this.pending;
      this.pending = undefined;
      await new Promise<void>((resolve) => {
        const body = JSON.stringify({ terminalId: this.connection.terminalId, token: this.connection.token, state });
        const req = request(this.connection.url, {
          method: "POST", agent: false,
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        });
        // A total deadline, not an inactivity timeout. Error text never contains
        // the capability token or a response body from the endpoint.
        const deadline = setTimeout(() => req.destroy(new Error("deadline")), 750);
        req.on("response", (res) => {
          this.error = res.statusCode === 204 ? undefined : `Activity endpoint returned HTTP ${res.statusCode}.`;
          clearTimeout(deadline);
          res.destroy();
          resolve();
        });
        req.on("error", () => {
          this.error = "Activity endpoint unavailable or timed out.";
          clearTimeout(deadline);
          resolve();
        });
        req.end(body);
      });
    }
    this.draining = undefined;
  }
}
