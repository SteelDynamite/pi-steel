import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.STEEL_TEST_PACKAGE_ROOT ?? join(here, ".."));

for (const variant of ["custom", "memory", "Everything", "ChatBot", "Everything-exclusions"]) test(`real delegation inherits ${variant}, behavioral agents, and manual resources without parent -e`, { timeout: 120_000 }, () => {
  const excluded = variant === "Everything-exclusions";
  const loadout = excluded ? "Everything" : variant;
  const memory = loadout !== "custom";
  const safety = loadout !== "ChatBot";
  const all = loadout === "memory" || loadout === "Everything";
  const shipped = loadout === "Everything" || loadout === "ChatBot";
  const home = mkdtempSync(join(tmpdir(), "steel-child-"));
  try {
    const agentDir = join(home, "agent");
    const cwd = join(home, "project");
    const manual = join(home, "manual");
    for (const directory of [agentDir, cwd, join(manual, "skills", "manual"), join(manual, "prompts")]) mkdirSync(directory, { recursive: true });
    copyFileSync(join(here, "fixtures/child-runtime.mjs"), join(manual, "index.mjs"));
    writeFileSync(join(manual, "package.json"), JSON.stringify({ name: "steel-child-manual", version: "1.0.0", pi: { extensions: ["index.mjs"], skills: ["skills"], prompts: ["prompts"] } }));
    writeFileSync(join(manual, "skills/manual/SKILL.md"), "---\nname: manual\ndescription: Manual child fixture skill.\n---\nManual instructions.\n");
    writeFileSync(join(manual, "prompts/manual.md"), "---\ndescription: Manual child fixture prompt\n---\nManual prompt.\n");
    writeFileSync(join(cwd, "protected.txt"), "original");
    writeFileSync(join(agentDir, "auth.json"), "{}");
    const preset = JSON.parse(readFileSync(join(root, "presets/memory/steel.json"), "utf8"));
    const memorySettings = JSON.parse(readFileSync(join(root, "presets/memory/settings.json"), "utf8"));
    const memorySource = "git:https://github.com/elpapi42/pi-observational-memory.git";
    const memoryPath = shipped ? join(agentDir, "git/github.com/elpapi42/pi-observational-memory") : join(home, "memory");
    if (memory) cpSync(join(here, "../node_modules/pi-observational-memory"), memoryPath, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      // Manual loads first to seed restored state before the real goal handler.
      packages: [manual, root, ...(memory ? [{ source: shipped ? memorySource : memoryPath }] : [])], defaultProvider: "steel-local", defaultModel: "fixture",
      compaction: { enabled: false }, retry: { enabled: false }, ...(memory ? memorySettings : {}),
      // The child resolves trust independently; grant it only in this isolated fixture.
      ...(excluded ? { defaultProjectTrust: "always" } : {}),
    }));
    const projectSettingsPath = join(cwd, ".pi/settings.json");
    if (excluded) {
      const replacement = join(home, "replacement");
      mkdirSync(replacement);
      writeFileSync(join(replacement, "package.json"), JSON.stringify({ name: "child-replacement", pi: { extensions: ["index.ts"] } }));
      writeFileSync(join(replacement, "index.ts"), 'export default function(pi) { pi.registerCommand("replacement-fixture", { description: "Independent replacement", handler: async () => {} }); }');
      mkdirSync(dirname(projectSettingsPath));
      writeFileSync(projectSettingsPath, JSON.stringify({ packages: [{
        source: root, autoload: false, extensions: ["-extensions/pi-doc-manifests/index.ts"], skills: ["!extensions/pi-doc-manifests/skills/**/*"],
      }, replacement] }));
    }
    const projectBefore = excluded ? readFileSync(projectSettingsPath, "utf8") : undefined;
    if (memory) {
      // Seed completed external ownership: print mode cannot confirm installs.
      preset.loadouts.memory.external = [memoryPath];
      preset.managed = [{ source: memoryPath }];
    }
    writeFileSync(join(agentDir, "steel.json"), JSON.stringify(shipped ? { version: 1, active: loadout, loadouts: {}, managed: [{ source: memorySource }] } : memory ? preset : { version: 1, active: "children", managed: [], loadouts: {
      children: { bundled: ["pi-subagent", "pi-read-before-write", "pi-goal", "pi-mindful", "pi-recap"], external: [] },
    } }));
    const parent = join(home, "parent-only.mjs");
    writeFileSync(parent, `
import assert from "node:assert/strict";
export default function(pi) {
  assert.notEqual(process.env.PI_ORCHESTRATED_CHILD, "1", "parent -e leaked into child");
  pi.registerCommand("parent-only", { description: "Must not reach child", handler: async () => {} });
}
`);
    const hostRoot = getPackageDir();
    const host = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
    const networkAttempts = join(home, "network-attempts");
    const childReport = join(home, "child-report.json");
    const delegationReport = join(home, "delegation-report.json");
    // No ambient env, API keys, auth paths, NODE_OPTIONS, or parent resource flags.
    // Keep Node's native TypeScript behavior; the only inherited preload denies
    // networking before either CLI initializes.
    const result = spawnSync(process.execPath, [join(hostRoot, host.bin.pi), "--offline", excluded ? "--approve" : "--no-approve", "--no-session", "-p",
      "-e", parent, "/steel sync", "Delegate child inspection to the bundled worker."], {
      cwd, encoding: "utf8", timeout: 100_000,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), NO_COLOR: "1", PI_OFFLINE: "1",
        PI_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: `--import=${join(here, "fixtures/child-network-guard.mjs")}`,
        STEEL_NETWORK_ATTEMPTS: networkAttempts, STEEL_CHILD_REPORT: childReport, STEEL_DELEGATION_REPORT: delegationReport },
    });
    const diagnostics = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.error, undefined, `${result.error}\n${diagnostics}`);
    assert.equal(result.status, 0, diagnostics);
    assert(!existsSync(networkAttempts), "neither parent nor child may attempt network access");
    assert(existsSync(delegationReport), diagnostics);
    const parentReport = JSON.parse(readFileSync(delegationReport, "utf8"));
    assert.equal(parentReport.requests.length, 2, JSON.stringify(parentReport));
    assert(parentReport.requests.every((request: { tools: string[] }) => request.tools.includes("subagent")), "parent model sees bundled subagent");
    assert.equal(parentReport.result.toolName, "subagent");
    assert.notEqual(parentReport.result.isError, true, JSON.stringify(parentReport.result));
    const delegation = parentReport.result.details.results[0];
    assert.equal(delegation.agent, "worker");
    assert.equal(delegation.agentOrigin, "bundled");
    assert.equal(delegation.sessionIntent, "new");
    assert.equal(delegation.model, "steel-local/fixture");
    assert.equal(delegation.exitCode, 0, JSON.stringify(delegation));
    assert.equal(delegation.stopReason, "stop", JSON.stringify(delegation));
    assert(!/Failed to load extension|extension error/i.test(delegation.stderr), delegation.stderr);
    assert(existsSync(childReport), JSON.stringify(delegation));
    const child = JSON.parse(readFileSync(childReport, "utf8"));
    assert.equal(child.child, "1");
    assert.equal(child.agentDir, agentDir);
    assert(!child.argv.includes("-e") && !child.argv.includes("--extension"));
    const commands = child.commands.map((command: { name: string }) => command.name);
    assert(commands.includes("manual-fixture"));
    assert(commands.includes("manual"), "manual prompt survives filtering");
    assert(commands.includes("skill:manual"), "manual skill survives filtering");
    assert(!commands.includes("parent-only"));
    assert(!commands.includes("implement"), "subagent must not export workflow prompts to children");
    for (const name of ["goal", "mindful", "recap"]) assert.equal(commands.includes(name), safety, name);
    for (const name of ["doc-manifests-designer", "doc-manifests-maintainer", "doc-manifests-session-reviewer"]) assert.equal(commands.includes(`skill:${name}`), all && !excluded, name);
    assert.equal(commands.includes("doc-manifests"), all && !excluded);
    assert.equal(commands.includes("replacement-fixture"), excluded);
    if (excluded) {
      assert.equal(readFileSync(projectSettingsPath, "utf8"), projectBefore);
      assert.equal(JSON.parse(readFileSync(join(agentDir, "steel.json"), "utf8")).active, "Everything");
      const global = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
      assert(global.packages.find((entry: any) => entry.source === root).extensions.includes("+extensions/pi-doc-manifests/index.ts"));
    }
    assert.equal(child.tools.some((tool: { name: string }) => tool.name === "todo"), all, "bundled selection reaches child");
    assert.equal(commands.includes("om:status"), memory, "external memory reaches child");
    assert.equal(child.tools.some((tool: { name: string }) => tool.name === "recall"), memory);
    assert.equal(child.tools.find((tool: { name: string }) => tool.name === "subagent")?.exposure, "model-only");
    assert(!child.callable.includes("subagent"));
    assert.equal(child.results.subagent.isError, true, "nested invocation cannot bypass model-only exposure");
    assert.equal(child.results.blocked.isError === true, safety, "read-before-write follows the loadout");
    if (safety) assert.match(JSON.stringify(child.results.blocked), /has not been read in this session/);
    assert.equal(child.afterBlocked, safety ? "original" : "unsafe", "only enabled safety hooks block writes");
    assert.notEqual(child.results.read.isError, true);
    assert.notEqual(child.results.written.isError, true);
    assert.equal(readFileSync(join(cwd, "protected.txt"), "utf8"), "safe");
    assert.equal(child.requests.length, 2, "restored goal must not evaluate or continue child");
    assert(child.requests.every((request: { tools: string[] }) => request.tools.includes("subagent")), "model can see subagent");
    assert(!child.requests.some((request: { system: string }) => request.system.includes("Never finish this fixture goal")), "goal context suppressed");
    assert(!child.ui.some((event: { method: string; args: unknown[] }) => event.method === "setWorkingIndicator" || (event.method === "setWidget" && event.args[1])), "mindful child UI suppressed");
    assert(!child.entries.some((entry: { customType?: string }) => ["goal-context", "goal-evaluation"].includes(entry.customType ?? "")));
    assert.equal(readFileSync(join(agentDir, "auth.json"), "utf8"), "{}");
    assert(!/Failed to load extension|extension error/i.test(diagnostics), diagnostics);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
