import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { bundledFilters, plan, readConfig, readMemoryThresholds, synchronize, type Config } from "../src/manager.js";

const source = "git:https://github.com/elpapi42/pi-observational-memory.git";
const thresholds = readMemoryThresholds();
function fixture(t: test.TestContext, memory?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "steel-memory-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "root"), agentDir = join(dir, "agent"), cwd = join(dir, "project");
  for (const path of [root, agentDir, join(cwd, ".pi")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-steel", pi: { extensions: [] } }));
  const cache = join(agentDir, "git/github.com/elpapi42/pi-observational-memory");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "package.json"), JSON.stringify({ name: "pi-observational-memory", pi: { extensions: [] } }));
  const path = join(agentDir, "settings.json"), projectPath = join(cwd, ".pi/settings.json"), configPath = join(agentDir, "steel.json");
  const document = { packages: [bundledFilters(root, [], []), { source }], compaction: { enabled: true, reserveTokens: 12345 }, theme: "dark", unknown: { nested: [1, 2] }, ...(memory === undefined ? {} : { "observational-memory": memory }) };
  writeFileSync(path, JSON.stringify(document));
  const config: Config = { version: 1, active: "work", loadouts: { work: { bundled: [], external: [source] } }, managed: [{ source }] };
  writeFileSync(configPath, JSON.stringify(config));
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const host = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  host.install = async () => { throw new Error("unexpected download"); };
  const sync = () => synchronize(config, [], settings, host, root, agentDir, cwd, configPath);
  const preview = () => plan(config, [], settings, host, root, agentDir, cwd);
  return { root, agentDir, cwd, path, projectPath, configPath, config, document, settings, host, sync, preview };
}

test("memory-only drift replaces exactly three keys, preserves unowned settings, and converges", async t => {
  const memory = { observeAfterTokens: 30864, reflectAfterTokens: 61728, compactAfterTokens: 250000, compactAfterTokensMode: "calibrated", observationsPoolMaxTokens: 61728, observationsPoolTargetTokens: 30864, model: { provider: "local", id: "keep" }, passive: true, unknown: { keep: ["nested"] } };
  const f = fixture(t, memory);
  assert.equal(f.preview().changed, true);
  assert.deepEqual(f.preview().packages, f.document.packages, "only memory is drifting");
  assert.equal((await f.sync()).changed, true);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { ...f.document, "observational-memory": { ...memory, ...thresholds } });
  const bytes = readFileSync(f.path, "utf8");
  assert.equal((await f.sync()).changed, false);
  assert.equal(readFileSync(f.path, "utf8"), bytes);
  assert.equal(f.preview().changed, false);
  assert.deepEqual(readConfig(f.configPath, []).loadouts, f.config.loadouts, "no policy snapshot in steel.json");
});

test("an absent namespace receives only the three managed thresholds", async t => {
  const f = fixture(t);
  await f.sync();
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { ...f.document, "observational-memory": thresholds });
});

test("inactive memory preserves local settings and reactivation reapplies current policy", async t => {
  const f = fixture(t, { observeAfterTokens: 7 });
  f.config.active = "minimal";
  await f.sync();
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8"))["observational-memory"], { observeAfterTokens: 7 });
  f.config.managed = readConfig(f.configPath, []).managed;
  f.config.active = "work";
  await f.sync();
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8"))["observational-memory"], thresholds);
  f.config.managed = readConfig(f.configPath, []).managed;
  f.config.active = "minimal";
  await f.sync();
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8"))["observational-memory"], thresholds, "deactivation does not erase persisted settings");
});

test("manual memory is never claimed or configured, and a local lookalike gets no policy", async t => {
  const f = fixture(t, { observeAfterTokens: 7 });
  f.config.managed = [];
  const before = readFileSync(f.path, "utf8");
  await assert.rejects(f.sync(), /manual, modified, or project-owned/);
  assert.equal(readFileSync(f.path, "utf8"), before);
  const local = join(f.agentDir, "git/github.com/elpapi42/pi-observational-memory");
  f.config.loadouts.work!.external = [local];
  f.config.managed = [{ source: local }];
  writeFileSync(f.path, JSON.stringify({ ...f.document, packages: [bundledFilters(f.root, [], []), { source: local }] }));
  await f.settings.reload();
  assert.equal(f.preview().memoryThresholds, undefined);
  await f.sync();
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8"))["observational-memory"], { observeAfterTokens: 7 });
});

for (const memory of [null, [], "bad", { compactAfterTokensMode: "ratio" }]) test(`invalid or incompatible global memory is preserved: ${JSON.stringify(memory)}`, async t => {
  const f = fixture(t, memory);
  const before = readFileSync(f.path, "utf8");
  await assert.rejects(f.sync(), /observational-memory.*(object|conflicts)/);
  assert.equal(readFileSync(f.path, "utf8"), before);
});

for (const memory of [null, [], { observeAfterTokens: 123 }, { compactAfterTokensMode: "ratio" }]) test(`untrusted project conflicts are refused at commit: ${JSON.stringify(memory)}`, async t => {
  const f = fixture(t);
  const project = JSON.stringify({ "observational-memory": memory, npmCommand: ["must-not-run"] });
  writeFileSync(f.projectPath, project);
  const before = readFileSync(f.path, "utf8");
  await assert.rejects(f.sync(), /Project observational-memory.*(object|conflicts)/);
  assert.equal(readFileSync(f.path, "utf8"), before);
  assert.equal(readFileSync(f.projectPath, "utf8"), project);
});

test("matching project thresholds and unrelated overrides remain untouched", async t => {
  const f = fixture(t);
  const project = JSON.stringify({ "observational-memory": { ...thresholds, model: { provider: "local", id: "project" }, compactAfterTokensMode: "calibrated" } });
  writeFileSync(f.projectPath, project);
  await f.sync();
  assert.equal(readFileSync(f.projectPath, "utf8"), project);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8"))["observational-memory"], thresholds);
});

test("the locked commit rebases memory and preserves concurrent unowned edits", async t => {
  const f = fixture(t, { model: { provider: "old", id: "old" } });
  const reload = f.settings.reload.bind(f.settings);
  let injected = false;
  f.settings.reload = async () => {
    await reload();
    if (injected) return;
    injected = true;
    const document = JSON.parse(readFileSync(f.path, "utf8"));
    document["observational-memory"] = { model: { provider: "new", id: "new" }, compactAfterTokens: 99, observationsPoolMaxTokens: 77 };
    document.newUnrelated = "preserve";
    writeFileSync(f.path, JSON.stringify(document));
  };
  await f.sync();
  const saved = JSON.parse(readFileSync(f.path, "utf8"));
  assert.deepEqual(saved["observational-memory"], { model: { provider: "new", id: "new" }, observationsPoolMaxTokens: 77, ...thresholds });
  assert.equal(saved.newUnrelated, "preserve");
});

test("a failed required download leaves memory thresholds unchanged", async t => {
  const f = fixture(t, { compactAfterTokens: 250000 });
  f.config.loadouts.work!.external.push("npm:missing");
  const before = readFileSync(f.path, "utf8");
  await assert.rejects(f.sync(), /unexpected download/);
  assert.equal(readFileSync(f.path, "utf8"), before);
});
