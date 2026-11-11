import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { activityConnection, ActivityReporter } from "../activity.js";
import type { DiagnosticFields } from "../diagnostics.js";

const env = {
  PASEO_TERMINAL_ID: "terminal", PASEO_ACTIVITY_TOKEN: "private-token",
  PASEO_TERMINAL_ACTIVITY_URL: "http://127.0.0.1:6767/api/terminal-activity",
};

test("activity accepts only complete literal loopback HTTP endpoints", () => {
  assert(activityConnection(env));
  assert(activityConnection({ ...env, PASEO_TERMINAL_ACTIVITY_URL: "http://[::1]:6767/api/terminal-activity" }));
  for (const url of ["http://evil.test/api/terminal-activity", "http://localhost/api/terminal-activity", "https://127.0.0.1/api/terminal-activity", "http://127.0.0.1/wrong", "http://user:pass@127.0.0.1/api/terminal-activity", "http://127.0.0.1/api/terminal-activity?token=x", "http://127.0.0.1/api/terminal-activity#x", "not a URL"]) {
    assert.equal(activityConnection({ ...env, PASEO_TERMINAL_ACTIVITY_URL: url }), undefined, url);
  }
  for (const field of Object.keys(env)) assert.equal(activityConnection({ ...env, [field]: "" }), undefined);
});

test("ordered reporting is bounded to one in-flight and one latest state", async () => {
  const bodies: any[] = [];
  const replies: (() => void)[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    replies.push(() => { res.writeHead(204).end(); });
    server.emit("report");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const connection = activityConnection({ ...env, PASEO_TERMINAL_ACTIVITY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/terminal-activity` })!;
    const events: DiagnosticFields[] = [];
    const reporter = new ActivityReporter(connection, { emit: event => { events.push(event); } });
    const first = once(server, "report");
    const done = reporter.report("running", { source: "agent_start", idle: false, waiting: false });
    await first;
    reporter.report("needs-input");
    reporter.report("running");
    reporter.report("idle");
    assert.equal(bodies.length, 1);
    const second = once(server, "report");
    replies.shift()!();
    await second;
    replies.shift()!();
    await done;
    assert.deepEqual(bodies, [
      { terminalId: "terminal", token: "private-token", state: "running" },
      { terminalId: "terminal", token: "private-token", state: "idle" },
    ]);
    assert.equal(reporter.error, undefined);
    assert.deepEqual(events.filter(event => event.phase === "queued").map(event => [event.request, event.replaced, event.inFlight]), [
      [1, undefined, undefined], [2, undefined, 1], [3, 2, 1], [4, 3, 1],
    ]);
    assert.deepEqual(events.filter(event => event.phase === "request_start").map(event => event.request), [1, 4]);
    assert.deepEqual(events.filter(event => event.phase === "request_end").map(event => [event.request, event.outcome, event.status]), [[1, "ok", 204], [4, "ok", 204]]);
    assert(events.filter(event => event.request === 1).every(event => event.source === "agent_start" && event.idle === false && event.waiting === false));
    assert(events.filter(event => event.phase === "request_end").every(event => Number.isFinite(event.durationMs)));
    const third = once(server, "report");
    const next = reporter.report("needs-input");
    await third;
    replies.shift()!();
    await next;
    assert.equal(bodies.at(-1)!.state, "needs-input", "drain can restart after completion");
  } finally { server.closeAllConnections(); server.close(); }
});

test("timeouts and HTTP failures are silent, bounded, and never follow redirects", async () => {
  let count = 0;
  const server = createServer((_req, res) => {
    count++;
    if (count === 1) res.writeHead(302, { Location: "http://evil.test/" }).end("private-token");
    else if (count === 3) res.writeHead(204).end();
    // The second response deliberately hangs.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const events: DiagnosticFields[] = [];
    const reporter = new ActivityReporter(activityConnection({ ...env, PASEO_TERMINAL_ACTIVITY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/terminal-activity` })!, { emit: event => { events.push(event); } });
    await reporter.report("running");
    assert.equal(reporter.error, "Activity endpoint returned HTTP 302.");
    const start = Date.now();
    await reporter.report("idle");
    assert(Date.now() - start < 2500);
    assert.match(reporter.error!, /unavailable or timed out/);
    assert.equal(count, 2, "no automatic retries or redirect requests");
    await reporter.report("running");
    assert.equal(reporter.error, undefined, "a subsequent lifecycle event can recover");
    assert.deepEqual(events.filter(event => event.phase === "request_end").map(event => event.outcome), ["http", "deadline", "ok"], "recovery must not erase prior failure diagnostics");
    assert(events.some(event => event.phase === "request_end" && event.status === 302));
    assert(!JSON.stringify(events).includes("private-token"));
    assert(!JSON.stringify(events).includes("evil.test"));
  } finally { server.closeAllConnections(); server.close(); }
});
