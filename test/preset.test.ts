import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { parseConfig, select } from "../src/manager.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.STEEL_TEST_PACKAGE_ROOT ?? sourceRoot);
const upstreamRoot = join(sourceRoot, "node_modules/pi-observational-memory");
const manifest = JSON.parse(readFileSync(join(root, "extensions.manifest.json"), "utf8"));
const preset = JSON.parse(readFileSync(join(root, "presets/memory/steel.json"), "utf8"));
const settings = JSON.parse(readFileSync(join(root, "presets/memory/settings.json"), "utf8"));
// Import only inert definitions; never resolve the caller's personal settings.
const upstream = await import(pathToFileURL(join(upstreamRoot, "src/config.ts")).href);

test("memory preset selects every bundled member and follows upstream's default branch", () => {
  const config = parseConfig(preset, manifest.extensions);
  assert.equal(config.active, "memory");
  assert.deepEqual(config.managed, []);
  assert.deepEqual(select(config, manifest.extensions).bundled, manifest.extensions.map((member: { id: string }) => member.id));
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
