import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { transactSettings } from "../src/settings.js";
import { bundledFilters, parseConfig, plan, readConfig, sameSource, synchronize, type Config, type Member } from "../src/manager.js";

const member: Member = { id: "one", source: "https://github.com/example/one.git", revision: "abc", entry: "extensions/one/index.ts", skills: ["extensions/one/skills"], prompts: ["extensions/one/prompts"], assets: ["extensions/one/agents"] };
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "steel-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "root");
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  for (const path of [root, agentDir, cwd]) mkdirSync(path);
  const file = (path: string, data: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
  file(join(root, "index.ts"), "export default () => {};");
  file(join(root, member.entry), "export default () => {};");
  file(join(root, member.skills![0]!, "skill", "SKILL.md"), "---\nname: skill\ndescription: test\n---\ntest");
  file(join(root, member.prompts![0]!, "one.md"), "test");
  file(join(root, "package.json"), JSON.stringify({ pi: { extensions: ["index.ts", member.entry], skills: member.skills, prompts: member.prompts } }));
  file(join(agentDir, "settings.json"), JSON.stringify({ packages: [root], skills: ["manual-skills"], extensions: ["manual.ts"] }));
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const host = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const config: Config = { version: 1, active: "full", loadouts: {}, managed: [] };
  const configPath = join(agentDir, "steel.json");
  return { dir, root, agentDir, cwd, settings, host, config, configPath, file };
}

test("strict configuration rejects unknown IDs, names, fields and malformed ownership", () => {
  const base = { version: 1, active: "work", loadouts: { work: { bundled: ["one"], external: [] } } };
  assert.equal(parseConfig(base, [member]).active, "work");
  assert.throws(() => parseConfig({ ...base, unexpected: true }, [member]));
  assert.throws(() => parseConfig({ ...base, active: "absent" }, [member]));
  assert.throws(() => parseConfig(base, []), /Unknown bundled ID/);
  assert.throws(() => parseConfig({ ...base, managed: ["manual"] }, [member]));
  assert.throws(() => parseConfig({ ...base, loadouts: { full: { bundled: [], external: [] } } }, [member]));
});

test("native resource filters switch all companion resources while retaining manager", async t => {
  const f = fixture(t);
  for (const active of ["minimal", "full"]) {
    f.settings.setPackages([bundledFilters(f.root, [member], active === "full" ? [member.id] : [])]);
    const resolved = await f.host.resolve(async () => "error");
    assert(resolved.extensions.find(r => r.path === join(f.root, "index.ts"))?.enabled);
    for (const type of ["extensions", "skills", "prompts"] as const) {
      const companions = resolved[type].filter(r => r.path !== join(f.root, "index.ts") && r.metadata.origin === "package");
      assert(companions.length > 0, type);
      assert(companions.every(r => r.enabled === (active === "full")), `${active}: ${type}: ${JSON.stringify(companions)}`);
    }
  }
});

test("synchronization preserves unrelated declarations/settings and is idempotent", async t => {
  const f = fixture(t);
  const manual = { source: "npm:unrelated@1.0.0", extensions: ["custom.ts"] };
  f.settings.setPackages([f.root, manual]);
  f.config.active = "minimal";
  assert((await synchronize(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd, f.configPath)).changed);
  assert.deepEqual(f.settings.getGlobalSettings().packages![1], manual);
  assert.deepEqual(f.settings.getGlobalSettings().skills, ["manual-skills"]);
  assert.deepEqual(f.settings.getGlobalSettings().extensions, ["manual.ts"]);
  assert(!(await synchronize(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd, f.configPath)).changed);
});

test("external members become inactive, remain installed, and can be removed from custom loadout", async t => {
  const f = fixture(t);
  const external = join(f.dir, "external");
  f.file(join(external, "package.json"), JSON.stringify({ pi: { extensions: ["index.ts"] } }));
  f.file(join(external, "index.ts"), "export default () => {};");
  f.config.active = "work";
  f.config.loadouts.work = { bundled: [], external: [external] };
  await synchronize(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd, f.configPath);
  const owned = readConfig(f.configPath, [member]);
  owned.loadouts.work!.external = [];
  await synchronize(owned, [member], f.settings, f.host, f.root, f.agentDir, f.cwd, f.configPath);
  assert.deepEqual(f.settings.getGlobalSettings().packages![1], { source: external, extensions: [], skills: [], prompts: [], themes: [] });
  assert.equal(f.host.getInstalledPath(external, "user"), external);
  const resources = await f.host.resolve(async () => "error");
  assert.equal(resources.extensions.find(r => r.path === join(external, "index.ts"))?.enabled, false);
});

test("failed installs do not change resource settings or claim convergence", async t => {
  const f = fixture(t);
  f.file(f.configPath, JSON.stringify(f.config));
  f.config.active = "work";
  f.config.loadouts.work = { bundled: [], external: ["npm:new-one", "npm:new-two"] };
  let installed = false;
  const host = { getInstalledPath: (source: string, scope: "user" | "project") => source === "npm:new-one" && installed ? f.dir : f.host.getInstalledPath(source, scope), install: async (source: string) => { if (source === "npm:new-two") throw new Error("network unavailable"); installed = true; } };
  const before = f.settings.getGlobalSettings();
  await assert.rejects(synchronize(f.config, [member], f.settings, host, f.root, f.agentDir, f.cwd, f.configPath), /completed downloads: npm:new-one/);
  assert.deepEqual(f.settings.getGlobalSettings(), before);
  assert.equal(readConfig(f.configPath, [member]).active, "full");
});

test("manual external, modified ownership, standalone identities and project overrides fail closed", t => {
  const f = fixture(t);
  f.config.active = "work";
  f.config.loadouts.work = { bundled: [], external: ["npm:manual@2"] };
  const attempt = () => plan(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd);
  f.settings.setPackages([f.root, "npm:manual@1"]);
  assert.throws(attempt, /will not claim/);
  f.config.managed = [{ source: "npm:manual@1" }];
  assert.throws(attempt, /will not claim/);
  f.settings.setPackages([f.root, { source: "npm:manual@1" }]);
  assert.throws(attempt, /identity changed/);
  f.config = { version: 1, active: "minimal", loadouts: {}, managed: [] };
  f.settings.setPackages([f.root, "git:github.com/example/one@v2"]);
  assert.throws(attempt, /Standalone one/);
  f.settings.setPackages([f.root]);
  f.settings.setProjectPackages([f.root]);
  assert.throws(attempt, /Project Steel/);
});

test("root must be configured as a package, not merely a directly loaded entry", t => {
  const f = fixture(t);
  f.settings.setPackages([join(f.root, "index.ts")]);
  assert.throws(() => plan(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd), /exactly one global package/);
});

test("host source identity handles refs, SSH/HTTPS, npm versions, and scope-relative local paths", () => {
  assert(sameSource("git:git@github.com:example/one.git@v1", "/agent", "https://github.com/example/one@v2"));
  assert(sameSource("npm:@example/one@1", "/agent", "npm:@example/one@2"));
  assert(sameSource("./one", "/agent", "../agent/one", "/project"));
  assert(!sameSource("./one", "/agent", "./one", "/project"));
  assert(!sameSource("https://github.com/example/one", "/agent", "https://github.com/example/two"));
});

test("journal recovers failed filter writes without claiming manual packages", async t => {
  const f = fixture(t);
  const source = join(f.dir, "external");
  f.file(join(source, "package.json"), "{}");
  f.config.managed = [{ source }];
  f.settings.setPackages([f.root, { source }]);
  f.config.active = "minimal";
  // Simulate interruption after the ownership journal, before settings commit.
  f.file(f.configPath, JSON.stringify({ ...f.config, pending: [{ source, extensions: [], skills: [], prompts: [], themes: [] }] }));
  const interrupted = readConfig(f.configPath, [member]);
  assert(interrupted.pending);
  assert((await synchronize(interrupted, [member], f.settings, f.host, f.root, f.agentDir, f.cwd, f.configPath)).changed);
  assert.equal(readConfig(f.configPath, [member]).pending, undefined);
});

test("direct standalone entries are rejected, unrelated direct entries remain untouched", t => {
  const f = fixture(t);
  const direct = join(f.dir, "standalone", "index.ts");
  f.file(direct, "export default () => {};");
  f.file(join(dirname(direct), "package.json"), JSON.stringify({ name: member.id }));
  f.settings.setExtensionPaths([direct]);
  assert.throws(() => plan(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd), /Direct standalone/);
});

test("new external local sources cannot reintroduce bundled modules or alias the manager", t => {
  const f = fixture(t);
  f.config.active = "work";
  const standalone = join(f.dir, "standalone");
  f.file(join(standalone, "package.json"), JSON.stringify({ name: member.id, pi: { extensions: ["index.ts"] } }));
  f.file(join(standalone, "index.ts"), "export default () => {};");
  const alias = join(f.dir, "alias");
  symlinkSync(f.root, alias, "dir");
  for (const source of [standalone, join(standalone, "index.ts"), join(f.root, member.entry), alias]) {
    f.config.loadouts.work = { bundled: [], external: [source] };
    assert.throws(() => plan(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd), /bundled|manager|external file/i, source);
  }
});

test("manual removal of an owned member is restored, then synchronization is idempotent", async t => {
  const f = fixture(t);
  const external = join(f.dir, "external");
  f.file(join(external, "package.json"), "{}");
  f.config.active = "work";
  f.config.loadouts.work = { bundled: [], external: [external] };
  await synchronize(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd, f.configPath);
  const owned = readConfig(f.configPath, [member]);
  f.settings.setPackages(f.settings.getGlobalSettings().packages!.filter(entry => typeof entry === "string" || entry.source !== external));
  const calls: string[] = [];
  const host = { getInstalledPath: f.host.getInstalledPath.bind(f.host), install: async (source: string) => { calls.push(source); await f.host.install(source); } };
  assert((await synchronize(owned, [member], f.settings, host, f.root, f.agentDir, f.cwd, f.configPath)).changed);
  assert.deepEqual(calls, [external]);
  assert(!(await synchronize(readConfig(f.configPath, [member]), [member], f.settings, host, f.root, f.agentDir, f.cwd, f.configPath)).changed);
  assert.deepEqual(calls, [external]);
});

test("ordinary package installs during downloads survive synchronization", async t => {
  const f = fixture(t);
  const external = join(f.dir, "external");
  const manual = { source: "npm:manually-added", extensions: [] };
  f.file(join(external, "package.json"), "{}");
  f.config.active = "work";
  f.config.loadouts.work = { bundled: [], external: [external] };
  const host = { getInstalledPath: f.host.getInstalledPath.bind(f.host), install: async (source: string) => {
    await f.host.install(source);
    f.settings.setPackages([...f.settings.getGlobalSettings().packages!, manual]);
  } };
  await synchronize(f.config, [member], f.settings, host, f.root, f.agentDir, f.cwd, f.configPath);
  assert.deepEqual(f.settings.getGlobalSettings().packages![1], manual);
});

test("direct external files cannot be admitted or restored as inactive owned members", async t => {
  const f = fixture(t);
  const source = join(f.dir, "external.ts");
  f.file(source, "export default () => {};");
  f.settings.setPackages([f.root, { source, extensions: [] }]);
  const resolved = await f.host.resolve(async () => "error");
  assert.equal(resolved.extensions.find(r => r.path === source)?.enabled, true, "host ignores file filters");
  f.settings.setPackages([f.root]);
  f.config.active = "work";
  f.config.loadouts.work = { bundled: [], external: [source] };
  assert.throws(() => plan(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd), /external.*file/i);
  f.config.active = "minimal";
  f.config.managed = [{ source }];
  assert.throws(() => plan(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd), /external.*file/i);
});

test("second Steel identities are rejected even at another path or repository", t => {
  const f = fixture(t);
  const source = join(f.dir, "second-steel");
  f.file(join(source, "package.json"), JSON.stringify({ name: "pi-steel" }));
  for (const entry of [source, "npm:pi-steel@2", "git:github.com/SteelDynamite/pi-steel@other"]) {
    f.settings.setPackages([f.root, entry]);
    assert.throws(() => plan(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd), /manager|Steel.*identity/i);
  }
  f.settings.setPackages([f.root]);
  f.config.active = "work";
  f.config.loadouts.work = { bundled: [], external: [source] };
  assert.throws(() => plan(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd), /manager/);
});

test("failed repair with malformed cache metadata retries after restarting", async t => {
  const f = fixture(t);
  const source = "npm:repair";
  const cache = join(f.dir, "partial");
  f.config.active = "work";
  f.config.loadouts.work = { bundled: [], external: [source] };
  f.config.managed = [{ source }];
  f.settings.setPackages([f.root, { source }]);
  f.file(f.configPath, JSON.stringify(f.config));
  let calls = 0;
  const host = {
    getInstalledPath: (value: string, scope: "user" | "project") => value === source ? (calls ? cache : undefined) : f.host.getInstalledPath(value, scope),
    install: async () => {
      calls++;
      mkdirSync(cache, { recursive: true });
      f.file(join(cache, "package.json"), calls === 1 ? "{" : '{"name":"repaired"}');
      if (calls === 1) throw new Error("partial download");
    },
  };
  await assert.rejects(synchronize(f.config, [member], f.settings, host, f.root, f.agentDir, f.cwd, f.configPath), /partial download/);
  const interrupted = readConfig(f.configPath, [member]);
  assert.deepEqual(interrupted.incomplete, [source]);
  assert.doesNotThrow(() => plan({ ...interrupted, active: "minimal" }, [member], f.settings, host, f.root, f.agentDir, f.cwd), "broken owned package can still be disabled");
  await synchronize(interrupted, [member], f.settings, host, f.root, f.agentDir, f.cwd, f.configPath);
  assert.equal(calls, 2, "partial directory must not count as a completed install");
  assert.equal(readConfig(f.configPath, [member]).incomplete, undefined);
});

test("atomic settings merge retains installs arriving between reload and commit", async t => {
  const f = fixture(t);
  const settingsPath = join(f.agentDir, "settings.json");
  f.file(settingsPath, JSON.stringify({ packages: [f.root], theme: "dark" }));
  const settings = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: false });
  const host = new DefaultPackageManager({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: settings });
  const reload = settings.reload.bind(settings);
  const manual = { source: "npm:concurrent-manual", extensions: [] };
  let injected = false;
  settings.reload = async () => {
    await reload();
    if (injected) return;
    injected = true;
    // A separate ordinary Pi writer commits after Steel's final reload.
    const release = lockfile.lockSync(settingsPath, { realpath: false });
    try {
      const disk = JSON.parse(readFileSync(settingsPath, "utf8"));
      disk.packages.push(manual);
      disk.theme = "light";
      disk.unknownSetting = { preserved: true };
      writeFileSync(settingsPath, JSON.stringify(disk));
    } finally { release(); }
  };
  f.config.active = "minimal";
  await synchronize(f.config, [member], settings, host, f.root, f.agentDir, f.cwd, f.configPath);
  const disk = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(disk.theme, "light");
  assert.deepEqual(disk.unknownSetting, { preserved: true });
  assert.deepEqual(disk.packages.at(-1), manual);
});

test("settings write errors report incomplete sync", async t => {
  const f = fixture(t);
  const reload = f.settings.reload.bind(f.settings);
  let release: (() => void) | undefined;
  f.settings.reload = async () => {
    await reload();
    release = lockfile.lockSync(join(f.agentDir, "settings.json"), { realpath: false });
  };
  try {
    await assert.rejects(synchronize(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd, f.configPath), /Sync incomplete: settings write failed.*already being held/);
  } finally { release?.(); }
});

test("a failed settings write preserves the journal and retries without losing manual packages", async t => {
  const f = fixture(t);
  const manual = { source: "npm:manual", extensions: [] };
  f.settings.setPackages([f.root, manual]);
  await f.settings.flush();
  f.config.active = "minimal";
  const settingsPath = join(f.agentDir, "settings.json");
  const original = fs.writeFileSync;
  const before = readFileSync(settingsPath, "utf8");
  const fault = t.mock.method(fs, "writeFileSync", ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (path === `${settingsPath}.${process.pid}.tmp`) {
      original(path, "{partial");
      throw new Error("injected disk failure after journaling");
    }
    return (original as Function)(path, ...args);
  }) as typeof fs.writeFileSync);
  syncBuiltinESMExports();
  try {
    await assert.rejects(synchronize(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd, f.configPath), /injected disk failure/);
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(settingsPath, "utf8"), before);
  const interrupted = readConfig(f.configPath, [member]);
  assert(interrupted.pending);
  await synchronize(interrupted, [member], f.settings, f.host, f.root, f.agentDir, f.cwd, f.configPath);
  assert.equal(readConfig(f.configPath, [member]).pending, undefined);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).packages.at(-1), manual);
});

test("atomic replacement preserves existing permissions despite process umask", t => {
  const f = fixture(t);
  const path = join(f.agentDir, "settings.json");
  fs.chmodSync(path, 0o664);
  const previous = process.umask(0o022);
  try {
    transactSettings(f.cwd, f.agentDir, snapshot => ({ packages: snapshot.getPackages(), changed: true }));
    assert.equal(fs.statSync(path).mode & 0o777, 0o664);
  } finally { process.umask(previous); }
});

test("the settings transaction excludes a separate ordinary Pi writer", t => {
  const f = fixture(t);
  const script = `import {SettingsManager} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
    const settings=SettingsManager.create(process.argv[1],process.argv[2],{projectTrusted:false});
    settings.setTheme('light'); await settings.flush();
    console.log(JSON.stringify(settings.drainErrors().map(e=>e.error.message)));`;
  const write = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, f.cwd, f.agentDir], { encoding: "utf8" })) as string[];
  transactSettings(f.cwd, f.agentDir, snapshot => {
    assert(write().some(error => /lock|held/i.test(error)), "other process must honor the global lock");
    return { packages: snapshot.getGlobalSettings().packages!, changed: false };
  });
  assert.deepEqual(write(), [], "ordinary writer succeeds after release");
  assert.equal(JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8")).theme, "light");
});

test("absent settings are locked before inspection and are not created on refusal", t => {
  const f = fixture(t);
  const path = join(f.agentDir, "settings.json");
  unlinkSync(path);
  const release = lockfile.lockSync(path, { realpath: false });
  try {
    assert.throws(() => transactSettings(f.cwd, f.agentDir, () => {
      assert.fail("must not read an unlocked absent file");
    }), /already being held/);
  } finally { release(); }
  assert.throws(() => transactSettings(f.cwd, f.agentDir, snapshot => {
    assert(lockfile.checkSync(path, { realpath: false }), "absent file must be locked during planning");
    return plan(f.config, [member], snapshot, f.host, f.root, f.agentDir, f.cwd);
  }), /exactly one global/);
  assert.throws(() => readFileSync(path), /ENOENT/);
  assert.throws(() => readFileSync(f.configPath), /ENOENT/);
});

for (const conflict of ["manual ownership", "project declaration", "global direct extension"] as const) {
  test(`final locked replan rejects concurrent ${conflict}`, async t => {
    const f = fixture(t);
    const source = join(f.dir, "external");
    f.file(join(source, "package.json"), "{}");
    f.config.active = "work";
    f.config.loadouts.work = { bundled: [], external: [source] };
    f.config.managed = [{ source }];
    f.settings.setPackages([f.root, { source }]);
    await f.settings.flush();
    const reload = f.settings.reload.bind(f.settings);
    f.settings.reload = async () => {
      await reload();
      if (conflict === "project declaration") {
        f.file(join(f.cwd, ".pi", "settings.json"), JSON.stringify({ packages: [f.root] }));
      } else {
        const disk = JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"));
        if (conflict === "manual ownership") disk.packages[1] = { source, extensions: ["custom.ts"] };
        else disk.extensions = [join(f.root, member.entry)];
        f.file(join(f.agentDir, "settings.json"), JSON.stringify(disk));
      }
    };
    await assert.rejects(synchronize(f.config, [member], f.settings, f.host, f.root, f.agentDir, f.cwd, f.configPath), /manual, modified|Project Steel|Direct standalone/);
    const disk = JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"));
    assert.equal(disk.packages[0], f.root, "refusal must not write Steel filters");
    assert.throws(() => readFileSync(f.configPath), /ENOENT/, "refusal must not journal new ownership");
  });
}
