import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultPackageManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import steel from "../index.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstream = "git:https://github.com/elpapi42/pi-observational-memory.git";

function fixture(t: test.TestContext, active?: string, external: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "steel-startup-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldChild = process.env.PI_ORCHESTRATED_CHILD;
  const oldOffline = process.env.PI_OFFLINE;
  const install = DefaultPackageManager.prototype.install;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_ORCHESTRATED_CHILD;
  delete process.env.PI_OFFLINE;
  t.after(() => {
    DefaultPackageManager.prototype.install = install;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldChild === undefined) delete process.env.PI_ORCHESTRATED_CHILD; else process.env.PI_ORCHESTRATED_CHILD = oldChild;
    if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline;
    rmSync(dir, { recursive: true, force: true });
  });
  const settingsPath = join(dir, "settings.json");
  const configPath = join(dir, "steel.json");
  const manual = { source: "npm:manual", extensions: ["+keep.ts"], skills: ["keep/**"] };
  writeFileSync(settingsPath, JSON.stringify({ packages: [root, manual], theme: "dark", skills: ["manual-skills"] }));
  if (active) writeFileSync(configPath, JSON.stringify({ version: 1, active, managed: [], loadouts: active === "custom" ? { custom: { bundled: [], external } } : {} }));
  const installs: string[] = [];
  DefaultPackageManager.prototype.install = async function(source) {
    installs.push(source);
    const path = source === upstream ? join(dir, "git/github.com/elpapi42/pi-observational-memory") : source;
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: "startup-external", pi: { extensions: [] } }));
  };
  const notices: { message: string; type: string }[] = [];
  const statuses: string[] = [];
  t.after(() => assert.deepEqual(statuses, [], "Steel must not publish footer status"));
  let reloads = 0;
  let confirmations = 0;
  const ctx = { cwd: dir, mode: "tui", hasUI: true, ui: {
    notify: (message: string, type: string) => notices.push({ message, type }),
    setStatus: (_key: string, value: string) => statuses.push(value),
    confirm: async () => { confirmations++; return false; },
  }, reload: async () => { reloads++; } } as unknown as ExtensionCommandContext;
  const runtime = () => {
    const handlers: Record<string, (...args: any[]) => any> = {};
    let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    steel({ on: (name: string, handler: (...args: any[]) => any) => { handlers[name] = handler; }, registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
      sendMessage: () => assert.fail("startup must not send messages or trigger turns"),
      sendUserMessage: () => assert.fail("startup must not trigger turns"),
      appendEntry: () => assert.fail("request-local warnings must not persist"),
    } as unknown as ExtensionAPI);
    return { start: () => handlers.session_start({}, ctx), context: (messages: unknown[]) => handlers.context({ messages }, ctx), command: (args: string) => command(args, ctx) };
  };
  return { dir, settingsPath, configPath, manual, installs, notices, statuses, ctx, runtime,
    counts: () => ({ reloads, confirmations }) };
}

test("startup defaults to Everything, downloads without confirmation, preserves manual resources and only warns until command reload", async t => {
  const f = fixture(t);
  const r = f.runtime();
  assert(!existsSync(f.configPath), "factory has no side effects");
  await r.start();
  assert.deepEqual(f.installs, [upstream]);
  assert.deepEqual(f.counts(), { reloads: 0, confirmations: 0 });
  const saved = JSON.parse(readFileSync(f.settingsPath, "utf8"));
  assert(saved.packages.some((entry: unknown) => JSON.stringify(entry) === JSON.stringify(f.manual)));
  assert.equal(saved.theme, "dark");
  assert.deepEqual(saved.skills, ["manual-skills"]);
  assert.equal(JSON.parse(readFileSync(f.configPath, "utf8")).active, "Everything");
  assert(f.notices.some(n => n.type === "warning" && /Everything.*reload/.test(n.message)));
  const original = [{ role: "user", content: "first request", timestamp: 1 }];
  for (let request = 0; request < 2; request++) {
    const transformed = r.context(original);
    assert.equal(original.length, 1, "context hook must not mutate transcript");
    assert.equal(transformed.messages.length, 2);
    assert.equal(transformed.messages[1].customType, "steel-loadout-warning");
    assert.equal(transformed.messages[1].display, false);
    assert.match(transformed.messages[1].content, /Everything.*not applied.*subagent/s);
  }
  const settingsBefore = readFileSync(f.settingsPath, "utf8");
  const configBefore = readFileSync(f.configPath, "utf8");
  await r.start();
  assert.deepEqual(f.installs, [upstream], "repeated startup must not download twice");
  assert.equal(readFileSync(f.settingsPath, "utf8"), settingsBefore);
  assert.equal(readFileSync(f.configPath, "utf8"), configBefore);
  await r.command("sync");
  assert.deepEqual(f.counts(), { reloads: 1, confirmations: 0 }, "pending runtime reloads even if disk matches");
  const fresh = f.runtime();
  await fresh.start();
  assert.equal(fresh.context(original), undefined, "fresh runtime no longer injects a warning");
  assert(f.notices.some(n => n.type === "info" && n.message === "Steel loadout: Everything"));
  await fresh.command("sync");
  assert.equal(f.counts().reloads, 1);
});

test("orchestrated children skip startup mutations, downloads, and warning injection", async t => {
  const f = fixture(t);
  process.env.PI_ORCHESTRATED_CHILD = "1";
  const before = readFileSync(f.settingsPath, "utf8");
  const r = f.runtime();
  await r.start();
  assert.equal(readFileSync(f.settingsPath, "utf8"), before);
  assert(!existsSync(f.configPath));
  assert.deepEqual(f.installs, []);
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.statuses, []);
  assert.equal(r.context([]), undefined);
  assert.deepEqual(f.counts(), { reloads: 0, confirmations: 0 });
});

test("concurrent startup refuses an existing Steel lock without changing settings or stealing it", async t => {
  const f = fixture(t, "full");
  const lock = join(f.dir, "steel.lock");
  writeFileSync(lock, "another session");
  const before = readFileSync(f.settingsPath, "utf8");
  const r = f.runtime();
  await r.start();
  assert.equal(readFileSync(f.settingsPath, "utf8"), before);
  assert.equal(readFileSync(lock, "utf8"), "another session");
  assert.deepEqual(f.installs, []);
  assert.match(r.context([]).messages[0].content, /EEXIST/);
  assert(f.notices.some(n => n.type === "error" && /EEXIST/.test(n.message)));
});

test("offline startup does not install missing packages and warns the agent", async t => {
  const f = fixture(t);
  process.env.PI_OFFLINE = "1";
  const before = readFileSync(f.settingsPath, "utf8");
  const r = f.runtime();
  await r.start();
  assert.deepEqual(f.installs, []);
  assert.equal(readFileSync(f.settingsPath, "utf8"), before);
  assert(!existsSync(f.configPath));
  assert.match(r.context([]).messages[0].content, /offline mode/);
  assert(f.notices.some(n => n.type === "error" && /offline mode/.test(n.message)));
});

test("partial startup download failure reports completed downloads without claiming applied resources and can retry", async t => {
  const f = fixture(t, "custom", []);
  const first = join(f.dir, "first");
  const second = join(f.dir, "second");
  writeFileSync(f.configPath, JSON.stringify({ version: 1, active: "custom", managed: [], loadouts: { custom: { bundled: [], external: [first, second] } } }));
  const install = DefaultPackageManager.prototype.install;
  let fail = true;
  DefaultPackageManager.prototype.install = async function(source, ...args) {
    if (source === second && fail) throw new Error("fixture download failure");
    return install.call(this, source, ...args);
  };
  const before = readFileSync(f.settingsPath, "utf8");
  const r = f.runtime();
  await r.start();
  assert.equal(readFileSync(f.settingsPath, "utf8"), before);
  assert.deepEqual(f.installs, [first]);
  assert.match(f.notices.at(-1)!.message, /Sync incomplete.*second.*completed downloads:.*first.*No resource declarations changed/);
  assert.equal(f.notices.at(-1)!.type, "error");
  assert.match(r.context([]).messages[0].content, /failed.*Do not claim it was applied/s);
  assert.deepEqual(f.counts(), { reloads: 0, confirmations: 0 });
  fail = false;
  await r.start();
  assert(f.notices.some(n => n.type === "warning" && /Saved changes require \/reload/.test(n.message)));
  assert.doesNotMatch(r.context([]).messages[0].content, /failed/);
  const fresh = f.runtime();
  const count = f.installs.length;
  await fresh.start();
  assert.equal(f.installs.length, count);
  assert.equal(fresh.context([]), undefined);
});
