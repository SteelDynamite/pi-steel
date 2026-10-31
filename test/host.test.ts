import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAgentSession, DefaultResourceLoader, getPackageDir, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionCommandContextActions,
} from "@earendil-works/pi-coding-agent";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.STEEL_TEST_PACKAGE_ROOT ?? sourceRoot);

// A separate process sets HOME before host/modules cache configuration paths. No user
// settings, credentials, sessions, network requests, or model turns enter this test.
if (process.env.STEEL_HOST_TEST_CHILD !== "1") {
  test("real host: full → minimal → custom, ownership, reload, and fresh-project discovery", { timeout: 120_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "steel-host-"));
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
        cwd: sourceRoot,
        env: {
          PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(),
          PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
          STEEL_HOST_TEST_CHILD: "1", STEEL_TEST_PACKAGE_ROOT: root, NO_COLOR: "1",
        },
        encoding: "utf8", timeout: 110_000,
      });
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
} else {
  await exerciseHost();
}

function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, contents] of Object.entries(snapshot(path))) files[join(entry.name, name)] = contents;
    } else files[entry.name] = readFileSync(path).toString("base64");
  }
  return files;
}

async function exerciseHost(): Promise<void> {
  const home = process.env.HOME!;
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  const cwd = join(home, "fresh-project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd);
  // A fresh project uses the same public instructions as the source package.
  writeFileSync(join(cwd, "AGENTS.md"), readFileSync(join(sourceRoot, "AGENTS.md")));
  const packagePaths: Record<string, string> = {};
  for (const name of ["manual", "external"]) {
    const path = join(home, name);
    packagePaths[name] = path;
    mkdirSync(join(path, "skills", name), { recursive: true });
    mkdirSync(join(path, "prompts"));
    mkdirSync(join(path, "themes"));
    writeFileSync(join(path, "package.json"), JSON.stringify({
      name: `steel-test-${name}`, version: "1.0.0",
      pi: { extensions: ["index.ts"], skills: ["skills"], prompts: ["prompts"], themes: ["themes"] },
    }));
    writeFileSync(join(path, "index.ts"), `export default function(pi) { pi.registerCommand("${name}-fixture", { description: "Local fixture", handler: async () => {} }); }`);
    writeFileSync(join(path, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Local ${name} ownership test.\n---\nLocal test instructions.\n`);
    writeFileSync(join(path, "prompts", `${name}.md`), `---\ndescription: Local ${name} prompt\n---\nLocal test prompt.\n`);
    const theme = JSON.parse(readFileSync(join(getPackageDir(), "dist/modes/interactive/theme/dark.json"), "utf8"));
    theme.name = name;
    writeFileSync(join(path, "themes", `${name}.json`), JSON.stringify(theme));
  }
  // Test the pinned upstream artifact unchanged, using a local source to keep
  // automated host checks offline. The shipped preset retains its Git identity.
  packagePaths.memory = join(home, "memory");
  cpSync(join(sourceRoot, "node_modules/pi-observational-memory"), packagePaths.memory, { recursive: true });
  const memoryPreset = JSON.parse(readFileSync(join(root, "presets/memory/steel.json"), "utf8"));
  const memorySettings = JSON.parse(readFileSync(join(root, "presets/memory/settings.json"), "utf8"));
  const settingsPath = join(agentDir, "settings.json");
  const configPath = join(agentDir, "steel.json");
  const hostPackage = JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8"));
  // Package commands must be the first argument; offline mode is environmental.
  const bootstrap = spawnSync(process.execPath, [join(getPackageDir(), hostPackage.bin.pi), "install", root], { cwd, encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1" } });
  assert.equal(bootstrap.status, 0, `${bootstrap.stdout}\n${bootstrap.stderr}`);
  const installedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(installedSettings.packages.map((source: string) => resolve(agentDir, source)), [root], "fresh Pi bootstrap declares the entire package relative to its settings");
  writeFileSync(settingsPath, JSON.stringify({ ...installedSettings, packages: [...installedSettings.packages, packagePaths.manual], theme: "dark", compaction: { enabled: false }, retry: { enabled: false }, ...memorySettings }));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false,
  });
  const model = modelRuntime.getModels()[0];
  assert(model, "host static catalog must supply a model without credentials");
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });
  const beforeStartup = snapshot(home);
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model,
    sessionManager: SessionManager.inMemory(cwd),
  });
  const errors: unknown[] = [];
  const notices: string[] = [];
  let reloads = 0;
  const unsupported = async (): Promise<never> => { throw new Error("Unexpected session navigation"); };
  const actions: ExtensionCommandContextActions = {
    waitForIdle: () => session.waitForIdle(),
    newSession: unsupported, fork: unsupported, navigateTree: unsupported, switchSession: unsupported,
    reload: async () => { reloads++; await session.reload(); },
  };
  try {
    await session.bindExtensions({
      mode: "rpc", onError: error => errors.push(error), commandContextActions: actions,
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: message => { notices.push(message); }, confirm: async () => true,
      },
    });
    assert.deepEqual(snapshot(home), beforeStartup, "factory/session startup must not mutate settings, installations, or the project");
    const members = JSON.parse(readFileSync(join(root, "extensions.manifest.json"), "utf8")).extensions as { id: string; entry: string }[];
    assert.equal(members.length, 13);
    await checkState(session, loader, members.map(member => member.entry), true, true, false, errors);
    assert.deepEqual(loader.getAgentsFiles().agentsFiles.filter(file => file.path === join(cwd, "AGENTS.md")).map(file => file.content), [readFileSync(join(sourceRoot, "AGENTS.md"), "utf8")]);
    const freshEntries = session.sessionManager.getEntries();
    assert(!JSON.stringify(freshEntries).includes("## Diagnostics"), "fresh project must have no document-manifest diagnostics");

    await session.prompt("/steel use minimal");
    assert.equal(reloads, 1, notices.join("\n"));
    await checkState(session, loader, [], false, false, false, errors);
    const minimalSettings = readFileSync(settingsPath, "utf8");
    await session.prompt("/steel sync");
    assert.equal(reloads, 1, "idempotent sync must not reload");
    assert.equal(readFileSync(settingsPath, "utf8"), minimalSettings);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.loadouts.custom = { bundled: ["pi-doc-manifests", "pi-subagent"], external: [packagePaths.external] };
    config.loadouts.docs = { bundled: ["pi-doc-manifests"], external: [] };
    config.loadouts.agents = { bundled: ["pi-subagent"], external: [] };
    config.loadouts.memory = { ...memoryPreset.loadouts.memory, external: [packagePaths.memory] };
    writeFileSync(configPath, JSON.stringify(config));
    await session.prompt("/steel use custom");
    assert.equal(reloads, 2, notices.join("\n"));
    await checkState(session, loader, members.filter(member => config.loadouts.custom.bundled.includes(member.id)).map(member => member.entry), true, true, true, errors);
    const externalInstalled = snapshot(packagePaths.external);
    const manualInstalled = snapshot(packagePaths.manual);
    await session.prompt("/steel use docs");
    assert.equal(reloads, 3, notices.join("\n"));
    await checkState(session, loader, [members.find(member => member.id === "pi-doc-manifests")!.entry], true, false, false, errors);
    await session.prompt("/steel use agents");
    assert.equal(reloads, 4, notices.join("\n"));
    await checkState(session, loader, [members.find(member => member.id === "pi-subagent")!.entry], false, true, false, errors);
    await session.prompt("/steel use custom");
    assert.equal(reloads, 5, notices.join("\n"));
    await checkState(session, loader, members.filter(member => config.loadouts.custom.bundled.includes(member.id)).map(member => member.entry), true, true, true, errors);
    const memoryInstalled = snapshot(packagePaths.memory);
    for (const active of ["memory", "minimal", "memory"]) {
      await session.prompt(`/steel use ${active}`);
      const enabled = active === "memory";
      await checkState(session, loader, enabled ? members.map(member => member.entry) : [], enabled, enabled, false, errors);
      assert.equal(!!session.extensionRunner.getCommand("om:status"), enabled);
      assert.equal(!!session.extensionRunner.getCommand("om:view"), enabled);
      assert.equal(session.getActiveToolNames().includes("recall"), enabled);
      const currentSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.deepEqual(currentSettings["observational-memory"], memorySettings["observational-memory"], "switching preserves explicit memory settings");
      assert.deepEqual(currentSettings.compaction, { enabled: false }, "native compaction is not changed");
      if (enabled) {
        const start = notices.length;
        await session.prompt("/om:status");
        const status = notices.slice(start).join("\n");
        for (const [label, value] of [["Next observation", 30864], ["Next reflection", 61728], ["Next compaction", 250000], ["Visible observation pool", 61728], ["Active observation pool", 30864]] as const) {
          assert(status.split("\n").some(line => line.startsWith(`${label}:`) && line.includes(`/ ${value.toLocaleString()} `)), status);
        }
        const beforeSync: number = reloads;
        await session.prompt("/steel sync");
        assert.equal(reloads, beforeSync, "memory sync is idempotent");
      }
    }
    assert.deepEqual(snapshot(packagePaths.memory), memoryInstalled, "switching never modifies the upstream package");
    await session.prompt("/steel use custom");
    assert.deepEqual(snapshot(packagePaths.external), externalInstalled, "inactive external package remains installed and unchanged");
    assert.deepEqual(snapshot(packagePaths.manual), manualInstalled);
    assert(JSON.parse(readFileSync(settingsPath, "utf8")).packages.includes(packagePaths.manual), "manual declaration remains untouched");
    assert.deepEqual(errors, []);
    assert(!notices.some(message => /Steel:|Sync canceled/.test(message)), notices.join("\n"));

    // Discover from the loaded collection root: source checkout or installed tarball.
    const projectSettings = SettingsManager.create(root, agentDir, { projectTrusted: true });
    const projectLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: projectSettings });
    await projectLoader.reload();
    const { session: projectSession } = await createAgentSession({
      cwd: root, agentDir, settingsManager: projectSettings, resourceLoader: projectLoader,
      modelRuntime, model, sessionManager: SessionManager.inMemory(root),
    });
    const projectErrors: unknown[] = [];
    try {
      await projectSession.bindExtensions({ onError: error => projectErrors.push(error) });
      if (root === sourceRoot) assert(projectLoader.getAgentsFiles().agentsFiles.some(file => file.path === join(root, "AGENTS.md")));
      const before = await projectSession.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "Inspect collection discovery", images: undefined }, { cwd: root });
      const prompt = before.systemPromptOptions.forceSystemPrompt ?? "";
      assert(!prompt.includes("Subagent configuration errors"), prompt);
      assert(!JSON.stringify(projectSession.sessionManager.getEntries()).includes("## Available locational agents"));
      for (const name of ["reviewer", "scout", "worker"]) assert(prompt.includes(`<id>${name}</id>`), name);
      assert.deepEqual(projectLoader.getExtensions().errors, []);
      assert.deepEqual(projectLoader.getSkills().diagnostics, []);
      assert.deepEqual(projectLoader.getPrompts().diagnostics, []);
      assert(!JSON.stringify(projectSession.sessionManager.getEntries()).includes("## Diagnostics"), "pi-steel discovery must have no manifest diagnostics");
      assert.deepEqual(projectErrors, []);
    } finally {
      await projectSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      projectSession.dispose();
    }
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}

async function checkState(session: AgentSession, loader: DefaultResourceLoader, entries: string[], docs: boolean, agents: boolean, external: boolean, errors: unknown[]): Promise<void> {
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings ?? [], []);
  assert.deepEqual(loaded.extensions.filter(extension => extension.path.startsWith(`${root}/`)).map(extension => relative(root, extension.path)).sort(), ["index.ts", ...entries].sort());
  assert.deepEqual(loader.getSkills().diagnostics, []);
  assert.deepEqual(loader.getPrompts().diagnostics, []);
  assert.deepEqual(loader.getThemes().diagnostics, []);
  assert.deepEqual(session.extensionRunner.getCommandDiagnostics(), []);
  const skills = loader.getSkills().skills.map(skill => skill.name);
  const prompts = loader.getPrompts().prompts.map(prompt => prompt.name);
  const themes = loader.getThemes().themes.map(theme => theme.name);
  for (const name of ["doc-manifests-designer", "doc-manifests-maintainer", "doc-manifests-session-reviewer"]) assert.equal(skills.includes(name), docs, name);
  assert.equal(prompts.includes("implement"), agents);
  for (const [name, enabled] of [["manual", true], ["external", external]] as const) {
    assert.equal(skills.includes(name), enabled, `${name} skill`);
    assert.equal(prompts.includes(name), enabled, `${name} prompt`);
    assert.equal(themes.includes(name), enabled, `${name} theme`);
    assert.equal(!!session.extensionRunner.getCommand(`${name}-fixture`), enabled, `${name} extension`);
  }
  assert.equal(session.getActiveToolNames().includes("subagent"), agents);
  if (agents) assert.equal(session.extensionRunner.getToolDefinition("subagent")?.exposure, "model-only");
  const before = await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "Inspect resource availability", images: undefined }, { cwd: session.extensionRunner.createContext().cwd, selectedTools: session.getActiveToolNames() });
  for (const name of ["reviewer", "scout", "worker"]) assert.equal((before.systemPromptOptions.forceSystemPrompt ?? "").includes(`<id>${name}</id>`), agents, `${name} behavioral agent`);
  assert.deepEqual(errors, []);
}
