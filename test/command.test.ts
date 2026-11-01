import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultPackageManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import steel from "../index.js";

test("isolated command host: registration is inert, pending sync reloads, cancellation and child guards", async t => {
  const dir = mkdtempSync(join(tmpdir(), "steel-command-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldChild = process.env.PI_ORCHESTRATED_CHILD;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_ORCHESTRATED_CHILD;
  t.after(() => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldChild === undefined) delete process.env.PI_ORCHESTRATED_CHILD; else process.env.PI_ORCHESTRATED_CHILD = oldChild;
    rmSync(dir, { recursive: true, force: true });
  });
  let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => { throw new Error("not registered"); };
  steel({ on: (() => () => {}) as ExtensionAPI["on"], registerCommand: (_name, command) => { handler = command.handler; } } as ExtensionAPI);
  assert(!existsSync(join(dir, "steel.json")));
  assert(!existsSync(join(dir, "settings.json")));
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ packages: [root, "npm:unrelated"], theme: "dark" }));
  let reloads = 0;
  const messages: string[] = [];
  const context = { cwd: dir, hasUI: true, ui: { notify: (message: string) => messages.push(message), confirm: async () => false }, reload: async () => { reloads++; } } as unknown as ExtensionCommandContext;
  await handler("use minimal", context);
  assert.equal(reloads, 1, messages.join("\n"));
  // The mock reload does not replace the runtime; a fresh factory must clear pending state.
  steel({ on: (() => () => {}) as ExtensionAPI["on"], registerCommand: (_name, command) => { handler = command.handler; } } as ExtensionAPI);
  await handler("sync", context);
  assert.equal(reloads, 1);
  await handler("use missing", context);
  assert(messages.at(-1)?.includes("Unknown loadout"));
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).theme, "dark");
  const configPath = join(dir, "steel.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.loadouts.external = { bundled: [], external: [join(dir, "missing-external")] };
  writeFileSync(configPath, JSON.stringify(config));
  const before = readFileSync(settingsPath, "utf8");
  await handler("use external", context);
  assert(messages.at(-1)?.includes("canceled"));
  assert.equal(readFileSync(settingsPath, "utf8"), before);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).active, "minimal");
  process.env.PI_ORCHESTRATED_CHILD = "1";
  await handler("use full", context);
  assert(messages.at(-1)?.includes("orchestrated children"));
  assert.equal(readFileSync(settingsPath, "utf8"), before);
  assert.equal(reloads, 1);
});

test("untrusted project npmCommand never executes, including status", async t => {
  const dir = mkdtempSync(join(tmpdir(), "steel-untrusted-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; rmSync(dir, { recursive: true, force: true }); });
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const marker = join(dir, "executed");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [root, "npm:manual"] }));
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ npmCommand: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); console.log(${JSON.stringify(dir)});`, "--"] }));
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  steel({ on: (() => () => {}) as ExtensionAPI["on"], registerCommand: (_name, command) => { handler = command.handler; } } as ExtensionAPI);
  const messages: string[] = [];
  const ctx = { cwd: dir, hasUI: true, ui: { notify: (message: string) => messages.push(message), confirm: async () => false }, reload: async () => {} } as unknown as ExtensionCommandContext;
  await handler("status", ctx);
  assert(!existsSync(marker), messages.join("\n"));
  // Project declarations still participate in collision checks without project operational settings.
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ packages: [root] }));
  await handler("status", ctx);
  assert.match(messages.at(-1)!, /Project Steel/);
});

test("confirmation revalidates disk settings before invoking any installer", async t => {
  const dir = mkdtempSync(join(tmpdir(), "steel-confirm-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldChild = process.env.PI_ORCHESTRATED_CHILD;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_ORCHESTRATED_CHILD;
  const install = DefaultPackageManager.prototype.install;
  let installs = 0;
  DefaultPackageManager.prototype.install = async () => { installs++; };
  t.after(() => {
    DefaultPackageManager.prototype.install = install;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldChild === undefined) delete process.env.PI_ORCHESTRATED_CHILD; else process.env.PI_ORCHESTRATED_CHILD = oldChild;
    rmSync(dir, { recursive: true, force: true });
  });
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = join(dir, "external");
  mkdirSync(source);
  writeFileSync(join(source, "package.json"), "{}");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [root] }));
  writeFileSync(join(dir, "steel.json"), JSON.stringify({ version: 1, active: "minimal", loadouts: { work: { bundled: [], external: [source] } }, managed: [] }));
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  steel({ on: (() => () => {}) as ExtensionAPI["on"], registerCommand: (_name, command) => { handler = command.handler; } } as ExtensionAPI);
  const messages: string[] = [];
  const ctx = { cwd: dir, hasUI: true, ui: { notify: (message: string) => messages.push(message), confirm: async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [root, source] }));
    return true;
  } }, reload: async () => {} } as unknown as ExtensionCommandContext;
  await handler("use work", ctx);
  assert.equal(installs, 0, messages.join("\n"));
  assert.match(messages.at(-1)!, /manual|changed/i);
});
