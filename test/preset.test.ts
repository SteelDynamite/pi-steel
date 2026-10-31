import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("memory preset selects every bundled member and pins the tested upstream source", () => {
  const config = parseConfig(preset, manifest.extensions);
  assert.equal(config.active, "memory");
  assert.deepEqual(config.managed, []);
  assert.deepEqual(select(config, manifest.extensions).bundled, manifest.extensions.map((member: { id: string }) => member.id));
  const source = "git:https://github.com/elpapi42/pi-observational-memory.git@886f7a6628d10ea420eb6ceecaee36691489b2fb";
  assert.deepEqual(select(config, manifest.extensions).external, [source]);
  const pkg = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  assert.equal(pkg.devDependencies["pi-observational-memory"], source.replace("git:", "git+").replace(".git@", ".git#"));
  assert.equal(pkg.dependencies["pi-observational-memory"], undefined, "runtime package stays external");
  assert.deepEqual(JSON.parse(readFileSync(join(upstreamRoot, "package.json"), "utf8")).pi.extensions, ["./src/index.ts"], "test the upstream source entry, not a stale prebuilt bundle");
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

test("upstream proactive compaction uses the preset's 250k boundary", async () => {
  const { registerCompactionTrigger } = await import(pathToFileURL(join(upstreamRoot, "src/hooks/compaction-trigger.ts")).href);
  let handler!: (event: unknown, ctx: object) => unknown;
  const runtime = {
    config: { ...upstream.DEFAULTS, ...settings["observational-memory"], piAutoCompactionEnabled: false },
    ensureConfig() {}, compactInFlight: false,
  };
  registerCompactionTrigger({ on(name: string, fn: typeof handler) { assert.equal(name, "agent_settled"); handler = fn; } }, runtime);
  let tokens = 249999;
  let compactions = 0;
  const ctx = {
    cwd: root, hasUI: false, model: { contextWindow: 1000000 }, isIdle: () => true,
    sessionManager: { getBranch: () => [{ id: "source", type: "custom_message", content: "x".repeat(tokens * 4) }] },
    compact({ onComplete }: { onComplete: () => void }) { compactions++; onComplete(); },
  };
  await handler({}, ctx);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(compactions, 0);
  tokens = 250000;
  await handler({}, ctx);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(compactions, 1);
  assert.equal(runtime.compactInFlight, false);
});
