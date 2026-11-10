import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.STEEL_TEST_PACKAGE_ROOT ?? join(here, ".."));

test("real one-off delegation uses exact models, role/inline instructions and child tool selections", { timeout: 120000 }, () => {
  const home = mkdtempSync(join(tmpdir(), "steel-one-off-"));
  try {
    const agentDir = join(home, "agent");
    const cwd = join(home, "project");
    const provider = join(home, "provider");
    for (const dir of [agentDir, cwd, provider]) mkdirSync(dir);
    copyFileSync(join(here, "fixtures/one-off-runtime.mjs"), join(provider, "index.mjs"));
    writeFileSync(join(provider, "package.json"), JSON.stringify({ name: "steel-one-off-provider", pi: { extensions: ["index.mjs"] } }));
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      packages: [provider, root], defaultProvider: "steel-one-off", defaultModel: "parent",
      defaultThinkingLevel: "medium", retry: { enabled: false }, compaction: { enabled: false },
    }));
    writeFileSync(join(agentDir, "steel.json"), JSON.stringify({ version: 1, active: "one-off", managed: [],
      loadouts: { "one-off": { bundled: ["pi-subagent"], external: [] } } }));
    const reportPath = join(home, "report.json");
    const networkPath = join(home, "network-attempts");
    const hostRoot = getPackageDir();
    const host = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
    const run = spawnSync(process.execPath, [join(hostRoot, host.bin.pi), "--offline", "--no-approve", "--no-session", "-p", "/steel sync", "Test one-off delegations"], {
      cwd, encoding: "utf8", timeout: 110000,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), NO_COLOR: "1", PI_OFFLINE: "1",
        PI_CODING_AGENT_DIR: agentDir, STEEL_ONE_OFF_REPORT: reportPath, STEEL_NETWORK_ATTEMPTS: networkPath,
        NODE_OPTIONS: `--import=${join(here, "fixtures/child-network-guard.mjs")}` },
    });
    assert.equal(run.error, undefined, String(run.error));
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert(!existsSync(networkPath), "one-off tests must stay offline");
    assert(existsSync(reportPath), `${run.stdout}\n${run.stderr}`);
    const results = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(results.length, 6);
    for (const [index, mode] of ["overrides", "custom", "custom"].entries()) {
      const result = results[index];
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const detail = result.details.results[0];
      assert.equal(detail.configuration, mode);
      assert.equal(detail.model, "steel-one-off/audit");
      assert.equal(detail.agentOrigin, index === 0 ? "bundled" : "custom");
      assert.equal(detail.exitCode, 0, JSON.stringify(detail));
      const answer = detail.messages.findLast((message: any) => message.role === "assistant");
      const child = JSON.parse(answer.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join(""));
      assert.equal(child.model, "steel-one-off/audit");
      assert.equal(child.child, "1");
      assert.equal(child.agentDir, agentDir);
      assert.equal(child.cwd, cwd);
      assert(child.argv.includes("--no-session") && child.argv.includes("--no-approve"));
      assert(!child.argv.includes("--session-id"));
      assert.deepEqual(child.tools, index === 0 ? ["grep", "read"] : index === 1 ? ["read"] : []);
      assert.deepEqual(detail.agentTools, index === 0 ? ["read", "grep"] : index === 1 ? ["read"] : []);
      assert.equal(child.thinking, index === 0 ? "high" : index === 1 ? "low" : "medium");
      const prompt = child.argv[child.argv.indexOf("--append-system-prompt") + 1];
      assert(!existsSync(dirname(prompt)), "child prompt must be cleaned up");
      if (index === 0) {
        const role = readFileSync(join(root, "extensions/pi-subagent/agents/reviewer/SUBAGENTS.md"), "utf8").split(/^---\s*$/m).slice(2).join("---").trim();
        assert(child.system.includes(role), "role instructions must survive model override");
      } else assert(child.system.includes(index === 1 ? "INLINE_AUDIT_INSTRUCTIONS\n@literal-not-an-include.md" : "NO_TOOLS_INSTRUCTIONS"));
      assert.match(result.content[0].text, /One-off (overrides|custom): steel-one-off\/audit/);
    }
    assert.equal(results[3].isError, true);
    assert.match(results[3].content[0].text, /no fallback was attempted/);
    assert.equal(results[4].isError, true);
    assert.match(results[4].content[0].text, /collides with an existing agent/);
    assert.equal(results[5].isError, true);
    assert.match(results[5].content[0].text, /Requested exact model steel-one-off\/aud; child resolved steel-one-off\/audit/);
    assert(!results[5].details.results[0].messages.some((message: any) => message.role === "assistant"), "fuzzy child substitution must be blocked before any model request");
    assert.equal(readFileSync(join(agentDir, "auth.json"), "utf8"), "{}");
    assert(!/Failed to load extension|extension error/i.test(run.stderr), run.stderr);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
