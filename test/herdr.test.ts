import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage } from "@earendil-works/pi-ai";
import { bundledFilters } from "../src/manager.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.STEEL_TEST_PACKAGE_ROOT ?? sourceRoot);
const run = promisify(execFile);

if (!process.env.STEEL_HERDR_CASE) {
  test("Herdr: simultaneous Everything runtimes, fallback, child inheritance, reload, and owner exclusion", { timeout: 90_000, skip: process.platform === "win32" }, async () => {
    const home = mkdtempSync(join(tmpdir(), "steel-herdr-"));
    try {
      const agentDir = join(home, "agent");
      const bin = join(home, "bin");
      mkdirSync(bin);
      mkdirSync(agentDir);
      const hc = join(bin, "hc");
      writeFileSync(hc, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.STEEL_HERDR_PROBES, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.slice(2).join(' ') !== '--skill') process.exit(2);
if (process.env.STEEL_HERDR_FAILURE === 'timeout') setTimeout(() => {}, 60000);
else if (process.env.STEEL_HERDR_FAILURE) process.exit(1);
else console.log('# hc manual (herdr-core)\\n' + process.env.STEEL_HERDR_MANUAL);
`);
      chmodSync(hc, 0o700);
      const members = JSON.parse(readFileSync(join(root, "extensions.manifest.json"), "utf8")).extensions;
      const ids = JSON.parse(readFileSync(join(root, "loadouts.json"), "utf8")).loadouts.Everything.bundled;
      const memory = "git:https://github.com/elpapi42/pi-observational-memory.git";
      cpSync(join(sourceRoot, "node_modules/pi-observational-memory"), join(agentDir, "git/github.com/elpapi42/pi-observational-memory"), { recursive: true });
      const settingsPath = join(agentDir, "settings.json");
      const configPath = join(agentDir, "steel.json");
      writeFileSync(settingsPath, JSON.stringify({ packages: [bundledFilters(root, members, ids), { source: memory }], compaction: { enabled: false }, retry: { enabled: false } }));
      writeFileSync(configPath, JSON.stringify({ version: 1, active: "Everything", loadouts: {}, managed: [{ source: memory }] }));
      const settingsBefore = readFileSync(settingsPath, "utf8");
      const configBefore = readFileSync(configPath, "utf8");
      await Promise.all(["native", "herdr", "fallback", "timeout", "child", "child-fallback"].map(async variant => {
        const cwd = join(home, variant);
        mkdirSync(cwd);
        const network = join(home, `${variant}-network`);
        const probes = join(home, `${variant}-probes`);
        const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
          cwd: sourceRoot, timeout: 60_000,
          env: {
            PATH: `${bin}:${process.env.PATH}`, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
            STEEL_TEST_PACKAGE_ROOT: root, STEEL_HERDR_CASE: variant, STEEL_HERDR_CWD: cwd, STEEL_HERDR_PROBES: probes, STEEL_HERDR_MANUAL: "manual-v1",
            NODE_OPTIONS: `--import=${join(sourceRoot, "test/fixtures/child-network-guard.mjs")}`, STEEL_NETWORK_ATTEMPTS: network,
            ...(variant !== "native" ? { HC_TERMINAL_ID: `t-${variant}` } : {}),
            ...(variant.startsWith("child") ? { PI_ORCHESTRATED_CHILD: "1" } : {}),
            ...(["fallback", "timeout", "child-fallback"].includes(variant) ? { STEEL_HERDR_FAILURE: variant } : {}),
          },
        });
        assert.match(stdout, /Herdr case passed:/, `${stdout}\n${stderr}`);
        assert(!existsSync(network), `${variant} attempted networking`);
        if (variant === "native") assert(!existsSync(probes), "outside hc: no process probe");
        else for (const line of readFileSync(probes, "utf8").trim().split("\n")) assert.deepEqual(JSON.parse(line), ["--skill"], "never start or inspect a daemon");
      }));
      assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore, "simultaneous runtimes never switch global filters");
      assert.equal(readFileSync(configPath, "utf8"), configBefore, "Everything remains selected");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
} else {
  const variant = process.env.STEEL_HERDR_CASE;
  const cwd = process.env.STEEL_HERDR_CWD!;
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const requests: string[] = [];
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, extensionFactories: [pi => {
    pi.registerProvider("steel-herdr-local", {
      api: "steel-herdr-local", baseUrl: "http://invalid.invalid", apiKey: "local-test-not-a-credential",
      models: [{ id: "fixture", name: "Herdr fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context) {
        requests.push(getCurrentSystemPrompt(context.messages));
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          content: [{ type: "text", text: "Context inspected." }], stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
        return stream;
      },
    });
  }] });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json"), modelsStorePath: join(cwd, "models-cache.json"),
    refreshOnCreate: false, allowModelNetwork: false,
  });
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, sessionManager: SessionManager.inMemory(cwd) });
  const errors: unknown[] = [];
  const notices: string[] = [];
  try {
    await session.bindExtensions({
      mode: "rpc", onError: error => errors.push(error),
      uiContext: { ...session.extensionRunner.getUIContext(), notify: message => notices.push(message) },
    });
    // Extension providers become available on bind, after SDK initial model selection.
    const localModel = modelRuntime.getModels().find(model => model.provider === "steel-herdr-local");
    assert(localModel);
    await session.setModel(localModel);
    let expectedManual = "manual-v1";
    const check = async (herdr: boolean, native: boolean) => {
      const probes = process.env.STEEL_HERDR_PROBES!;
      const probesBefore = existsSync(probes) ? readFileSync(probes, "utf8") : "";
      assert.equal(session.getActiveToolNames().includes("subagent"), native);
      assert.equal(!!session.extensionRunner.getCommand("subagent-settings"), native);
      assert(!loader.getSkills().skills.some(skill => skill.name === "herdr-delegation"), "preloaded guide must not invite a redundant skill read");
      assert(session.getActiveToolNames().includes("todo"));
      assert(session.getActiveToolNames().includes("recall"));
      assert(loader.getSkills().skills.some(skill => skill.name === "doc-manifests-designer"));
      const before = await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "Inspect available delegation", images: undefined }, { cwd, selectedTools: session.getActiveToolNames() });
      for (const name of ["scout", "worker", "reviewer"]) assert.equal((before.systemPromptOptions.forceSystemPrompt ?? "").includes(`<id>${name}</id>`), native);
      const section = before.systemPromptOptions.sections.herdr_delegation;
      assert.equal(typeof section === "string", herdr);
      const requestCount = requests.length;
      await session.prompt("Inspect available delegation context; do not run tools.");
      assert.equal(requests.length, requestCount + 1, "one model request, no preparatory tool turns");
      const prompt = requests.at(-1)!;
      assert.equal(prompt.includes("## Installed hc manual (already loaded)"), herdr);
      if (herdr) {
        assert(section.includes(expectedManual));
        assert(prompt.includes(section), "the first request receives the full preloaded section");
        assert.equal(prompt.split("# hc manual (herdr-core)").length, 2, "manual appears exactly once");
        assert(prompt.includes(JSON.stringify({ HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, PI_CODING_AGENT_DIR: agentDir, cwd, projectTrusted: true })));
      }
      assert.equal(existsSync(probes) ? readFileSync(probes, "utf8") : "", probesBefore, "model turns reuse the startup manual without subprocess discovery");
      assert.deepEqual(loader.getSkills().diagnostics, []);
      assert.deepEqual(loader.getExtensions().errors, []);
      assert.deepEqual(errors, []);
      assert(!JSON.stringify(session.sessionManager.getEntries()).includes("## Diagnostics"));
    };
    const handedOff = variant === "herdr" || variant === "child";
    await check(handedOff, !handedOff);
    await check(handedOff, !handedOff);
    assert.equal(notices.filter(message => message.includes("Keeping native subagents")).length, variant === "fallback" || variant === "timeout" ? 1 : 0);
    if (variant === "herdr") {
      // A repaired or removed CLI is reconsidered on reload, not through polling.
      process.env.STEEL_HERDR_FAILURE = "removed";
      await session.reload();
      await check(false, true);
      delete process.env.STEEL_HERDR_FAILURE;
      process.env.STEEL_HERDR_MANUAL = expectedManual = "manual-v2";
      await session.reload();
      await check(true, false);
      const projectSettings = join(cwd, ".pi/settings.json");
      mkdirSync(dirname(projectSettings));
      writeFileSync(projectSettings, JSON.stringify({ packages: [{ source: root, autoload: false, extensions: ["-extensions/pi-subagent/index.ts"] }] }));
      await session.reload();
      await check(false, false);
      rmSync(projectSettings);
      await session.reload();
      await check(true, false);
    }
    console.log(`Herdr case passed: ${variant}`);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}
