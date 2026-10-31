import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.STEEL_TEST_PACKAGE_ROOT ?? join(here, ".."));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const plain = (value: string) => value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("real TUI: all 13 modules, local model, footer/editor/widgets, minimal → full reload", { timeout: 90_000 }, async (t) => {
  if (!["linux", "darwin"].includes(process.platform)) return t.skip("requires a POSIX script PTY");
  const probeArgs = process.platform === "darwin"
    ? ["-q", "/dev/null", "sh", "-c", "test -t 0 && test -t 1"]
    : ["-q", "-e", "-c", "test -t 0 && test -t 1", "/dev/null"];
  const probe = spawnSync("script", probeArgs, { encoding: "utf8", timeout: 5000 });
  if (probe.error || probe.status !== 0) return t.skip(`script PTY unavailable: ${probe.error ?? probe.stderr}`);

  const home = mkdtempSync(join(tmpdir(), "steel-tui-"));
  let child: ReturnType<typeof spawn> | undefined;
  let transcript = "";
  try {
    const agentDir = join(home, "agent");
    const cwd = join(home, "project");
    const manual = join(home, "manual");
    for (const path of [agentDir, cwd, manual, join(agentDir, "extensions")]) mkdirSync(path, { recursive: true });
    copyFileSync(join(here, "fixtures/tui-runtime.mjs"), join(manual, "index.mjs"));
    writeFileSync(join(manual, "package.json"), JSON.stringify({ name: "steel-tui-manual", version: "1.0.0", pi: { extensions: ["index.mjs"] } }));
    // Disable only auxiliary model requests, not the real suggestion editor.
    writeFileSync(join(agentDir, "extensions/prompt-suggestions.json"), JSON.stringify({ enabled: false }));
    mkdirSync(join(home, ".pi/agent"), { recursive: true });
    writeFileSync(join(home, ".pi/agent/mindful.json"), JSON.stringify({ delaySeconds: 0, style: "wave" }));
    writeFileSync(join(agentDir, "auth.json"), "{}");
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ packages: [manual, root], defaultProvider: "steel-tui-local", defaultModel: "fixture",
      theme: "dark", compaction: { enabled: false }, retry: { enabled: false } }));
    const members = JSON.parse(readFileSync(join(root, "extensions.manifest.json"), "utf8")).extensions as { id: string; entry: string }[];
    assert.equal(members.length, 13);
    const reportPath = join(home, "report.jsonl");
    const networkPath = join(home, "network-attempts");
    const hostRoot = getPackageDir();
    const host = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
    const invocation = [process.execPath, join(hostRoot, host.bin.pi), "--offline", "--no-approve", "--no-session", "--no-mcp", "--verbose", "--tui-mode", "regular"];
    const command = `stty rows 50 cols 160; exec ${invocation.map(quote).join(" ")}`;
    const args = process.platform === "darwin" ? ["-q", "/dev/null", "sh", "-c", command] : ["-q", "-f", "-e", "-c", command, "/dev/null"];
    child = spawn("script", args, { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: {
      PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), TERM: "xterm-256color", COLUMNS: "160", LINES: "50",
      PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TUI_DEBUG: "0",
      NODE_OPTIONS: `--import=${join(here, "fixtures/child-network-guard.mjs")}`,
      STEEL_NETWORK_ATTEMPTS: networkPath, STEEL_TUI_REPORT: reportPath,
    } });
    let spawnError: Error | undefined;
    child.on("error", error => { spawnError = error; });
    child.stdout!.on("data", data => { transcript += data.toString(); });
    child.stderr!.on("data", data => { transcript += data.toString(); });
    const events = (): any[] => existsSync(reportPath) ? readFileSync(reportPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const wait = async (description: string, condition: () => boolean) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (condition()) return;
        assert(!spawnError && child!.exitCode === null && child!.signalCode === null, `${description}: child exited ${spawnError ?? child!.exitCode}\n${plain(transcript)}`);
        await sleep(50);
      }
      assert.fail(`Timed out: ${description}\n${JSON.stringify(events())}\n${plain(transcript)}`);
    };
    const send = (text: string) => child!.stdin!.write(`${text}\r`);
    await wait("full editor and footer", () => ["setEditorComponent", "setFooter"].every(owner => events().some(event => event.event === "render" && event.owner === owner)));
    send("/tui-probe");
    await wait("initial full probe", () => events().some(event => event.event === "probe" && event.active === "full"));
    send("Exercise the local TUI fixture.");
    await wait("one model run settled", () => events().some(event => event.event === "settled"));
    await wait("todo widget rendered", () => events().some(event => event.event === "render" && event.owner === "todo"));
    await wait("rendered model response", () => plain(transcript).includes("TUI_LOCAL_COMPLETE"));
    assert.match(plain(transcript), /Breathe in/);
    for (const member of members) assert(plain(transcript).includes(`/extensions/${member.id}`), `${member.id} loaded in the real TUI`);
    assert(events().some(event => event.event === "widget" && event.owner === "pi-mindful"), "mindful working widget must be displayed");
    assert.equal(events().filter(event => event.event === "request").length, 2, "one run: todo tool call and final response only");

    for (const active of ["minimal", "full"]) {
      const starts = events().filter(event => event.event === "start").length;
      const outputOffset = transcript.length;
      send(`/steel use ${active}`);
      await wait(`${active} reload`, () => events().filter(event => event.event === "start").length > starts
        && plain(transcript.slice(outputOffset)).includes("Reloaded keybindings"));
      send("/tui-probe");
      const previousProbes = active === "full" ? 1 : 0;
      await wait(`${active} probe`, () => events().filter(event => event.event === "probe" && event.active === active).length > previousProbes);
      const runtime = events().filter(event => event.event === "probe").at(-1);
      assert.equal(runtime.mode, "tui");
      assert.equal(runtime.tools.includes("todo"), active === "full");
      assert.equal(runtime.tools.includes("subagent"), active === "full");
      assert.equal(runtime.commands.includes("mindful"), active === "full");
      assert(runtime.commands.includes("steel") && runtime.commands.includes("tui-probe"));
      const config = JSON.parse(readFileSync(join(agentDir, "steel.json"), "utf8"));
      assert.equal(config.active, active);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert(settings.packages.includes(manual), "unrelated manual package retained");
      const steel = settings.packages.find((entry: any) => entry.source === root);
      assert.deepEqual(steel.extensions, ["!**/*", "+index.ts", ...(active === "full" ? members.map(member => `+${member.entry}`) : [])]);
      assert.equal(settings.theme, "dark");
    }
    assert.equal(events().filter(event => event.event === "start").length, 3);
    assert.equal(events().filter(event => event.event === "render" && event.owner === "setFooter").length, 2);
    assert.equal(events().filter(event => event.event === "render" && event.owner === "setEditorComponent").length, 2);
    send("/quit");
    await wait("clean exit", () => child!.exitCode !== null);
    assert.equal(child.exitCode, 0, plain(transcript));
    assert.equal(events().filter(event => event.event === "request").length, 2, "reloads and shutdown must not trigger model work");
    assert(!existsSync(networkPath), "no process may attempt network access");
    assert.equal(readFileSync(join(agentDir, "auth.json"), "utf8"), "{}");
    assert.doesNotMatch(plain(transcript), /Failed to load extension|extension error|TypeError:|ReferenceError:|Steel: Error|exceeds terminal width|Unhandled|\[Extension (?:errors|conflicts)\]/i);
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      await sleep(100);
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
    rmSync(home, { recursive: true, force: true });
  }
});
