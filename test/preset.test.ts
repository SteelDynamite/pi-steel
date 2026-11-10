import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { parseConfig, readConfig, readLoadouts, saveConfig, select } from "../src/manager.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.STEEL_TEST_PACKAGE_ROOT ?? sourceRoot);
const upstreamRoot = join(sourceRoot, "node_modules/pi-observational-memory");
const manifest = JSON.parse(readFileSync(join(root, "extensions.manifest.json"), "utf8"));
const preset = JSON.parse(readFileSync(join(root, "presets/memory/steel.json"), "utf8"));
const settings = JSON.parse(readFileSync(join(root, "presets/memory/settings.json"), "utf8"));
// Import only inert definitions; never resolve the caller's personal settings.
const upstream = await import(pathToFileURL(join(upstreamRoot, "src/config.ts")).href);

test("optional keybindings load through Pi without replacing unrelated bindings", async t => {
  const bindings = JSON.parse(readFileSync(join(root, "presets/keybindings.json"), "utf8"));
  assert.deepEqual(bindings, {
    "tui.altScreen.lineUp": "alt+up",
    "tui.altScreen.lineDown": "alt+down",
    "app.message.dequeue": "alt+q",
  });
  const dir = mkdtempSync(join(tmpdir(), "steel-keybindings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ "app.session.new": "ctrl+shift+n", ...bindings }));
  // Pi does not export the concrete loader; exercise the installed host artifact.
  const { KeybindingsManager } = await import(pathToFileURL(join(getPackageDir(), "dist/core/keybindings.js")).href);
  const manager = KeybindingsManager.create(dir);
  for (const [action, key] of Object.entries(bindings)) assert.deepEqual(manager.getKeys(action), [key]);
  assert.deepEqual(manager.getKeys("app.session.new"), ["ctrl+shift+n"]);
  assert.deepEqual(manager.getKeys("tui.altScreen.pageUp"), ["pageUp"]);
  assert(manager.matches("\u001b[1;3A", "tui.altScreen.lineUp"));
  assert(manager.matches("\u001b[1;3B", "tui.altScreen.lineDown"));
  assert(!manager.matches("\u001b[1;3A", "app.message.dequeue"));
});

test("shipped selections default to Everything without persisting definitions", t => {
  const dir = mkdtempSync(join(tmpdir(), "steel-loadouts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "steel.json");
  const config = readConfig(path, manifest.extensions);
  assert.deepEqual(config, { version: 1, active: "Everything", loadouts: {}, managed: [] });
  assert.equal(existsSync(path), false);
  assert.deepEqual(select(config, manifest.extensions), {
    bundled: manifest.extensions.map((member: { id: string }) => member.id),
    external: ["git:https://github.com/elpapi42/pi-observational-memory.git"],
  });
  config.active = "ChatBot";
  assert.deepEqual(select(config, manifest.extensions), {
    bundled: ["pi-system-reminders", "pi-subagent"],
    external: ["git:https://github.com/elpapi42/pi-observational-memory.git"],
  });
  saveConfig(path, config);
  assert.deepEqual(readConfig(path, manifest.extensions), config);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).loadouts, {});
  const shipped = JSON.parse(readFileSync(join(root, "loadouts.json"), "utf8"));
  assert.deepEqual(readLoadouts(), shipped);
  for (const name of ["Everything", "ChatBot", "full", "minimal"]) {
    assert.throws(() => parseConfig({ ...config, loadouts: { [name]: { bundled: [], external: [] } } }, manifest.extensions), /Reserved/);
  }
  assert.deepEqual(select({ ...config, active: "full" }, manifest.extensions), { bundled: manifest.extensions.map((m: { id: string }) => m.id), external: [] });
  assert.deepEqual(select({ ...config, active: "minimal" }, []), { bundled: [], external: [] });
  assert.throws(() => select(config, []), /Unknown bundled ID/);
});

test("shipped definitions refresh from the module's package, not cwd or steel.json", async t => {
  const dir = mkdtempSync(join(tmpdir(), "steel-loadouts-refresh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src"));
  for (const name of ["manager.ts", "settings.ts"]) copyFileSync(join(root, "src", name), join(dir, "src", name));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  symlinkSync(join(sourceRoot, "node_modules"), join(dir, "node_modules"), "dir");
  const definitions = { version: 1, default: "Everything", loadouts: { Everything: { bundled: ["first"], external: [] as string[] }, ChatBot: { bundled: ["missing"], external: [] } } };
  const path = join(dir, "loadouts.json");
  writeFileSync(path, JSON.stringify(definitions));
  const manager = await import(pathToFileURL(join(dir, "src/manager.ts")).href);
  const members = [{ id: "first" }, { id: "second" }];
  const config = manager.readConfig(join(dir, "steel.json"), members);
  assert.deepEqual(manager.select(config, members).bundled, ["first"]);
  definitions.loadouts.Everything = { bundled: ["second"], external: ["npm:updated"] };
  writeFileSync(path, JSON.stringify(definitions));
  assert.deepEqual(manager.select(config, members), definitions.loadouts.Everything);
  assert.deepEqual(config.loadouts, {});
  assert.throws(() => manager.select({ ...config, active: "ChatBot" }, members), /Unknown bundled ID/);
  definitions.loadouts.Everything.bundled = ["second", "second"];
  writeFileSync(path, JSON.stringify(definitions));
  assert.throws(() => manager.select(config, members), /unique/);
  writeFileSync(path, JSON.stringify({ ...definitions, loadouts: { "bad name": definitions.loadouts.Everything }, default: "bad name" }));
  assert.throws(() => manager.select(config, members), /invalid shipped loadout/);
});

test("legacy memory preset keeps its selection and follows upstream's default branch", () => {
  const config = parseConfig(preset, manifest.extensions);
  assert.equal(config.active, "memory");
  assert.deepEqual(config.managed, []);
  assert.deepEqual(select(config, manifest.extensions).bundled, manifest.extensions.filter((member: { id: string }) => member.id !== "pi-paseo").map((member: { id: string }) => member.id));
  const source = "git:https://github.com/elpapi42/pi-observational-memory.git";
  assert.deepEqual(select(config, manifest.extensions).external, [source]);
  const pkg = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  assert.equal(pkg.devDependencies["pi-observational-memory"], source.replace("git:", "git+"));
  assert.equal(pkg.dependencies["pi-observational-memory"], undefined, "runtime package stays external");
  assert.deepEqual(JSON.parse(readFileSync(join(upstreamRoot, "package.json"), "utf8")).pi.extensions, ["./dist/index.ts"], "test the declared distributed entry");
  const lock = JSON.parse(readFileSync(join(sourceRoot, "package-lock.json"), "utf8"));
  assert.match(lock.packages["node_modules/pi-observational-memory"].resolved, /^git\+https:\/\/github\.com\/elpapi42\/pi-observational-memory\.git#[a-f0-9]{40}$/, "development lockfile still captures an exact artifact");
});

test("memory thresholds scale proportionally to 250k without changing capacity limits or native compaction", () => {
  assert.deepEqual(Object.keys(settings), ["observational-memory"]);
  const values = settings["observational-memory"];
  const keys = ["compactAfterTokens", "observeAfterTokens", "reflectAfterTokens", "observationsPoolMaxTokens", "observationsPoolTargetTokens"];
  assert.deepEqual(Object.keys(values).sort(), [...keys, "compactAfterTokensMode"].sort());
  assert.equal(values.compactAfterTokens, 250000);
  for (const key of keys) {
    assert.equal(values[key], Math.round(upstream.DEFAULTS[key] * 250000 / upstream.DEFAULTS.compactAfterTokens), key);
  }
  assert.equal(values.compactAfterTokensMode, "calibrated");
  for (const window of [undefined, 128000, 272000, 1000000]) {
    assert.equal(upstream.resolveCompactAfterTokens({ ...upstream.DEFAULTS, ...values }, window), 250000);
  }
});

test("distributed memory entry enforces the 250k boundary and compaction safeguards", { timeout: 30_000 }, () => {
  const home = mkdtempSync(join(tmpdir(), "steel-memory-entry-"));
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir);
    const result = spawnSync(process.execPath, ["--import", "tsx", join(sourceRoot, "test/fixtures/memory-entry.mjs"), root], {
      cwd: sourceRoot, encoding: "utf8", timeout: 25_000,
      env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
