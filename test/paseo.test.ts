import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.STEEL_TEST_PACKAGE_ROOT ?? sourceRoot);
const run = promisify(execFile);

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert(check(), message);
}

if (!process.env.STEEL_PASEO_CASE) {
  test("Paseo: actual host lifecycle, isolated settings, UI dialogs, reload, RPC and child boundaries", { timeout: 60_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "steel-paseo-"));
    try {
      for (const variant of ["tui", "native", "rpc", "child", "outside", "invalid"]) {
        const caseHome = join(home, variant);
        const agentDir = join(caseHome, "agent");
        const cwd = join(caseHome, "workspace");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(cwd);
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
        // Enabled inherited settings must not activate children or outside terminals.
        if (variant === "child" || variant === "outside") writeFileSync(join(agentDir, "paseo.json"), '{"tools":true,"unrelated":"preserved"}\n');
        const network = join(caseHome, "network-attempts");
        const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
          cwd: sourceRoot, timeout: 15_000,
          env: {
            PATH: process.env.PATH, HOME: caseHome, USERPROFILE: caseHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
            STEEL_TEST_PACKAGE_ROOT: root, STEEL_PASEO_CASE: variant, STEEL_PASEO_CWD: cwd,
            NODE_OPTIONS: `--import=${join(sourceRoot, "test/fixtures/paseo-network-guard.mjs")}`,
            STEEL_NETWORK_ATTEMPTS: network,
            ...(variant === "child" ? { PI_ORCHESTRATED_CHILD: "1" } : {}),
          },
        });
        assert.match(stdout, /Paseo case passed:/, `${stdout}\n${stderr}`);
        assert(!existsSync(network), `${variant} attempted nonfixture networking`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
} else {
  const variant = process.env.STEEL_PASEO_CASE;
  const cwd = process.env.STEEL_PASEO_CWD!;
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  const settingsPath = join(agentDir, "paseo.json");
  const diagnosticsPath = join(process.env.HOME!, ".pi-paseo-diagnostics", "activity.v1.log");
  const states: string[] = [];
  const httpErrors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/terminal-activity");
      assert.equal(req.headers["content-type"], "application/json");
      let body = "";
      for await (const chunk of req) body += chunk;
      const report = JSON.parse(body);
      assert.deepEqual(Object.keys(report).sort(), ["state", "terminalId", "token"]);
      assert.equal(report.terminalId, "fixture-terminal");
      assert.equal(report.token, "fixture-token-not-a-credential");
      assert(["idle", "running", "needs-input"].includes(report.state));
      states.push(report.state);
      res.writeHead(204).end();
    } catch (error) {
      httpErrors.push(error);
      res.writeHead(400).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  process.env.STEEL_PASEO_PORT = String(address.port);
  process.env.PASEO_TERMINAL_ACTIVITY_URL = `http://127.0.0.1:${address.port}/api/terminal-activity`;
  process.env.PASEO_ACTIVITY_TOKEN = variant === "invalid" ? "" : "fixture-token-not-a-credential";
  if (variant !== "outside" && variant !== "native") process.env.PASEO_TERMINAL_ID = "fixture-terminal";
  if (variant === "native" || variant === "rpc") process.env.PASEO_AGENT_ID = "fixture-agent";
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const releases: Array<() => void> = [];
  const lifecycle: string[] = [];
  const errors: unknown[] = [];
  const notices: string[] = [];
  const dialogs: Array<{ title: string; options: string[] }> = [];
  let closeDialog: ((value: string | undefined) => void) | undefined;
  let requestSubagent = false;
  let finishSubagent: (() => void) | undefined;
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings,
    additionalExtensionPaths: [join(root, "extensions/pi-paseo/index.ts")],
    extensionFactories: [pi => {
      // Represents a separately injected native Paseo tool; toggles must not own it.
      pi.registerTool({ name: "paseo_native_sentinel", label: "Sentinel", description: "Native sentinel", parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text", text: "native" }], details: {} }; } });
      // Deterministic foreground tool, not a provider/subprocess audit. The host
      // must emit the real tool lifecycle; contents must never enter diagnostics.
      pi.registerTool({ name: "subagent", label: "Subagent fixture", description: "Fixture", parameters: Type.Object({ task: Type.String() }),
        async execute() {
          await new Promise<void>(resolve => { finishSubagent = resolve; });
          return { content: [{ type: "text", text: "PRIVATE-TOOL-RESULT" }], details: {} };
        } });
      const record = async (event: { type: string }) => { lifecycle.push(event.type); };
      pi.on("agent_start", record);
      pi.on("agent_end", record);
      pi.on("agent_settled", record);
      pi.on("ui_prompt_start", record);
      pi.on("ui_prompt_end", record);
      pi.on("session_shutdown", record);
      pi.registerProvider("steel-paseo-local", {
        api: "steel-paseo-local", baseUrl: "http://invalid.invalid", apiKey: "fixture-not-a-credential",
        models: [{ id: "fixture", name: "Paseo fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(model) {
          const stream = createAssistantMessageEventStream();
          releases.push(() => {
            const message: AssistantMessage = {
              role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
              content: requestSubagent ? [{ type: "toolCall", id: "PRIVATE-TOOL-CALL-ID", name: "subagent", arguments: { task: "PRIVATE-TOOL-ARGUMENT" } }] : [{ type: "text", text: "Local response." }],
              stopReason: requestSubagent ? "toolUse" : "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            requestSubagent = false;
            stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
            stream.end();
          });
          return stream;
        },
      });
    }],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json"), modelsStorePath: join(cwd, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, sessionManager: SessionManager.inMemory(cwd) });
  const reporting = variant === "tui";
  try {
    await session.bindExtensions({
      mode: variant === "rpc" || variant === "native" ? "rpc" : "tui", onError: error => errors.push(error),
      uiContext: {
        ...session.extensionRunner.getUIContext(), notify: message => notices.push(message),
        select: async (title, options) => {
          dialogs.push({ title, options });
          return new Promise<string | undefined>(resolve => { closeDialog = resolve; });
        },
      },
    });
    const storeKey = Symbol.for("pi-steel.paseo.diagnostics.v1");
    const getStore = () => (globalThis as any)[storeKey];
    const initialStore = getStore();
    const initialWriter = initialStore?.writer;
    const model = modelRuntime.getModels().find(model => model.provider === "steel-paseo-local");
    assert(model);
    await session.setModel(model);
    assert.deepEqual(states, reporting ? ["idle"] : []);
    const checkTools = (enabled: boolean) => {
      assert(session.getActiveToolNames().includes("paseo_native_sentinel"), "native tool remains active");
      assert.equal(session.getActiveToolNames().includes("paseo_control"), enabled);
      const own = session.getAllTools().find(tool => tool.name === "paseo_control");
      if (variant === "child") assert.equal(own, undefined);
      else assert.equal(own?.exposure, enabled ? "direct" : "hidden");
    };
    checkTools(false);
    assert.equal(!!session.extensionRunner.getCommand("paseo"), variant !== "child");
    if (variant !== "child") {
      const status = session.prompt("/paseo status");
      await until(() => !!closeDialog, "status uses host select fallback");
      assert.deepEqual(dialogs.at(-1)!.options, ["Close"]);
      assert(dialogs.at(-1)!.title.includes(settingsPath));
      if (reporting || variant === "invalid") {
        assert(dialogs.at(-1)!.title.includes(diagnosticsPath));
        assert.match(dialogs.at(-1)!.title, /written=\d+, dropped=\d+, pending=\d+/);
        assert(!dialogs.at(-1)!.title.includes("fixture-token-not-a-credential"));
      } else assert.match(dialogs.at(-1)!.title, /Diagnostics: inactive/);
      assert.match(dialogs.at(-1)!.title, variant === "outside" ? /not detected/ : /Paseo: detected/);
      if (reporting) await until(() => states.at(-1) === "needs-input", "host UI start reports needs-input");
      closeDialog!("Close");
      closeDialog = undefined;
      await status;
      await until(() => lifecycle.includes("ui_prompt_end"), "host emits UI end");
      if (reporting) await until(() => states.at(-1) === "idle", "host UI end restores idle");
      assert.equal(lifecycle.filter(event => event === "ui_prompt_start").length, 1);
      assert.equal(lifecycle.filter(event => event === "ui_prompt_end").length, 1);
      await session.prompt("/paseo tools on");
      checkTools(variant !== "outside");
      assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).tools, true);
      await session.reload();
      assert.equal(lifecycle.filter(event => event === "session_shutdown").length, 1, "reload shuts down old extension instance");
      checkTools(variant !== "outside");
      assert.equal(getStore(), initialStore, "reload shares one process writer and counters");
      assert.equal(getStore()?.writer, initialWriter, "reload does not spawn another writer subprocess");
      await session.prompt("/paseo tools off");
      checkTools(false);
      assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).tools, false);
      await session.reload();
      checkTools(false);
      if (variant === "outside") assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).unrelated, "preserved");
    }
    // Refill the production diagnostics admission budget, without changing it.
    if (reporting) await delay(1000);
    const start = states.length;
    const settled = lifecycle.filter(event => event === "agent_settled").length;
    const prompt = session.prompt("First local turn");
    await until(() => releases.length === 1, "first deterministic provider request");
    if (reporting) await until(() => states.at(-1) === "running", "host agent start reports running");
    assert.equal(await session.followUp("Queued local follow-up"), "queued");
    releases.shift()!();
    await until(() => releases.length === 1, "queued follow-up reaches provider");
    assert.equal(lifecycle.filter(event => event === "agent_settled").length, settled, "queued continuation does not settle early");
    if (reporting) assert(!states.slice(start).includes("idle"), "no transient idle between queued turns");
    releases.shift()!();
    await prompt;
    await session.waitForIdle();
    await until(() => lifecycle.filter(event => event === "agent_settled").length > settled, "host settles after queue drains");
    // Pi drains this follow-up inside the same agent run (two provider requests).
    assert.equal(lifecycle.filter(event => event === "agent_start").length, 1);
    assert.equal(lifecycle.filter(event => event === "agent_end").length, 1);
    if (reporting) await until(() => states.at(-1) === "idle", "stable idle after queued turns");
    if (reporting) {
      requestSubagent = true;
      const audit = session.prompt("PRIVATE-PROMPT foreground audit");
      await until(() => releases.length === 1, "subagent tool-call provider response");
      releases.shift()!();
      await until(() => !!finishSubagent, "host starts foreground subagent");
      await until(() => states.at(-1) === "running", "parent remains running while awaiting foreground subagent");
      const waitingStart = states.length;
      await delay(50);
      assert(!states.slice(waitingStart).includes("idle"));
      finishSubagent!();
      await until(() => releases.length === 1, "provider receives completed subagent result");
      releases.shift()!();
      await audit;
      await session.waitForIdle();
      await until(() => states.at(-1) === "idle", "parent settles after foreground subagent");
    }
    const beforeShutdown = states.length;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    if (reporting) assert.deepEqual(states.slice(beforeShutdown), ["idle"], "shutdown awaits a final idle reset");
    else assert.deepEqual(states, [], "RPC, children and outside terminals never report activity");
    if (reporting || variant === "invalid") {
      await until(() => getStore().pending === 0, "diagnostic queue drains outside lifecycle hooks");
      assert.equal(getStore().failure, undefined, "actual Pi loader supports diagnostic writer execution");
      const decoded = await run(process.execPath, [join(root, "extensions/pi-paseo/diagnostics-read.mjs"), diagnosticsPath]);
      const events = decoded.stdout.trim().split("\n").map(line => JSON.parse(line));
      assert(events.some(event => event.source === "session_start" && event.eligibility === (reporting ? "enabled" : "invalid_connection")));
      assert(new Set(events.map(event => event.runtime)).size >= 3, "reloads use distinct runtime correlations");
      assert.equal(new Set(events.map(event => event.process)).size, 1);
      for (const secret of ["PRIVATE-", "fixture-terminal", "fixture-token", settingsPath, cwd, "/api/terminal-activity"]) assert(!decoded.stdout.includes(secret), secret);
      if (reporting) {
        const begin = events.find(event => event.phase === "subagent_start");
        const end = events.find(event => event.phase === "subagent_end");
        assert(begin && end);
        assert.equal(begin.call, end.call);
        assert.equal(begin.runtime, end.runtime);
        assert.equal(begin.idle, false);
        assert.equal(begin.waiting, false);
        assert.equal(end.isError, false);
        assert(begin.seq < end.seq);
        const requests = events.filter(event => event.phase === "request_start");
        assert(requests.length > 0);
        assert(requests.every(start => events.some(end => end.phase === "request_end" && end.runtime === start.runtime && end.request === start.request && end.status === 204 && end.outcome === "ok")));
        assert(events.some(event => event.source === "session_shutdown" && event.reason === "quit"));
        assert(events.some(event => event.source === "agent_settled" && event.aborted === false));
      } else assert(!events.some(event => event.phase === "request_start"));
    } else assert(!existsSync(diagnosticsPath), "native/RPC, child and outside sessions do not create logs");
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(httpErrors, []);
    console.log(`Paseo case passed: ${variant}`);
  } finally {
    session.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
