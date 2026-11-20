import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { unzipSync } from "fflate";
import { CURRENT_SESSION_VERSION, SessionManager, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import register, { exportSession } from "../index.js";

test("only a nonblank MausBot launcher marker registers the tool", t => {
  const original = process.env.OMB_MCP_CONFIG, codync = process.env.CODYNC_PI_MCP_SERVERS;
  t.after(() => {
    if (original === undefined) delete process.env.OMB_MCP_CONFIG; else process.env.OMB_MCP_CONFIG = original;
    if (codync === undefined) delete process.env.CODYNC_PI_MCP_SERVERS; else process.env.CODYNC_PI_MCP_SERVERS = codync;
  });
  assert(!JSON.parse(JSON.stringify(exportSession.parameters)).required?.includes("format"), "default HTML export takes no arguments");
  process.env.CODYNC_PI_MCP_SERVERS = "{}";
  for (const marker of [undefined, "", "  ", "/fixture/not-read"]) {
    if (marker === undefined) delete process.env.OMB_MCP_CONFIG; else process.env.OMB_MCP_CONFIG = marker;
    const tools: unknown[] = [];
    register({ registerTool: (tool: unknown) => tools.push(tool) } as unknown as ExtensionAPI);
    assert.deepEqual(tools, marker?.trim() ? [exportSession] : []);
  }
});

async function unpack(path: string, format: string) {
  assert.deepEqual(await readdir(dirname(path)), [`session-${format}.zip`], "only the ZIP survives");
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  const files = unzipSync(await readFile(path));
  assert.deepEqual(Object.keys(files), [`session.${format}`]);
  return Buffer.from(files[`session.${format}`]).toString();
}

test("HTML ZIP captures saved and in-memory trees; JSONL ZIP captures the active branch; attachment is attempted once", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pi export 'fixture'-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  t.after(() => { if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = agentDir; });
  const timestamp = new Date(0).toISOString();
  const header = { type: "session", version: CURRENT_SESSION_VERSION, id: "fixture", cwd, timestamp, parentSession: "/private/source.jsonl" };
  const entries = [["root", null], ["active", "root"], ["abandoned", "root"]].map(([id, parentId]) => ({ type: "custom", id, parentId, timestamp, customType: "fixture", data: id }));
  const file = join(cwd, "input.jsonl");
  const source = [header, ...entries].map(line => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(file, source);
  const sm = SessionManager.open(file, cwd);
  sm.branch("active");
  const memory = SessionManager.inMemory(cwd);
  memory.appendMessage({ role: "system", content: "", timestamp: 0, sections: { skills: "fixture skill list" }, toolsAdded: [{ name: "fixture", description: "fixture tool", parameters: {} }] });
  const fork = memory.getLeafId()!;
  memory.appendCustomEntry("fixture", "old branch");
  memory.branch(fork);
  memory.appendCustomEntry("fixture", "new branch");
  const calls: { path: string }[] = [];
  const bridge = {
    tools: [{ name: "agents_attach_file" }],
    async executeTool(name: string, args: { path: string }) {
      assert.equal(name, "agents_attach_file");
      calls.push(args);
      assert((await stat(args.path)).size > 0);
      return { isError: false, result: { content: [{ type: "text", text: "receipt" }] } };
    },
  };
  const run = (args: { format?: "html" | "jsonl" }, sessionManager = sm, host: object = bridge, signal?: AbortSignal) => exportSession.execute("call", args, signal, undefined, { cwd, sessionManager, ...host } as unknown as ExtensionToolContext);
  for (const sessionManager of [sm, memory]) {
    const result = await run({}, sessionManager);
    assert.deepEqual(calls.at(-1), { path: result.details.path });
    assert.equal(result.details.attached, true);
    const html = await unpack(result.details.path, "html");
    const encoded = /<script id="session-data"[^>]*>([^<]+)<\/script>/.exec(html)?.[1];
    assert(encoded, "Pi viewer embeds session data");
    assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64").toString()).entries, sessionManager.getEntries());
  }
  const jsonl = await run({ format: "jsonl" });
  assert.equal(calls.length, 3);
  const lines = (await unpack(jsonl.details.path, "jsonl")).trimEnd().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(lines.slice(1), entries.slice(0, 2));
  const { parentSession: _omitted, ...freshHeader } = header;
  assert.deepEqual(lines[0], { ...freshHeader, timestamp: lines[0].timestamp });
  assert.notEqual(lines[0].timestamp, timestamp);
  assert.equal(await readFile(file, "utf8"), source);
  for (const [host, expected] of [
    [{}, /unavailable/i],
    [{ ...bridge, executeTool: async () => ({ isError: true, result: { content: [{ type: "text", text: "too large" }] } }) }, /too large/],
    [{ ...bridge, executeTool: async () => { throw new Error("disconnected"); } }, /disconnected/],
  ] as const) {
    const result = await run({ format: "jsonl" }, memory, host);
    assert.equal(result.details.attached, false);
    assert.match(JSON.stringify(result.content), expected);
    assert.match(await unpack(result.details.path, "jsonl"), /new branch/);
  }
  const before = await readdir(cwd);
  await assert.rejects(run({}, sm, bridge, AbortSignal.abort()), /abort/i);
  memory.appendCustomEntry("not serializable", 1n);
  await assert.rejects(run({}, memory), /BigInt/);
  assert.deepEqual(await readdir(cwd), before, "no partial ZIP on generation failure");
});
