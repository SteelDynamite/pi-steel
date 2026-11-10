import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.STEEL_TEST_PACKAGE_ROOT ?? sourceRoot);

if (process.env.STEEL_DOC_REFRESH_CHILD !== "1") {
  test("real manifest refresh: tool turns, compaction, reload, removals and prompt coexistence", { timeout: 90000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "steel-doc-refresh-"));
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
        cwd: sourceRoot, encoding: "utf8", timeout: 80000,
        env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1",
          STEEL_DOC_REFRESH_CHILD: "1", STEEL_TEST_PACKAGE_ROOT: root,
          NODE_OPTIONS: `--import=${join(sourceRoot, "test/fixtures/child-network-guard.mjs")}`,
          STEEL_NETWORK_ATTEMPTS: join(home, "network-attempts") },
      });
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Manifest refresh verified: 7 requests/);
      assert(!existsSync(join(home, "network-attempts")));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
} else {
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  const cwd = join(process.env.HOME!, "project");
  const docs = join(cwd, ".agents/docs");
  mkdirSync(join(agentDir, "reminders"), { recursive: true });
  mkdirSync(join(cwd, ".agents/skills/creator"), { recursive: true });
  writeFileSync(join(agentDir, "reminders/fixture.ts"), 'export default () => ({on: "before_agent_start", when: () => false, message: "Unused fixture reminder"});');
  writeFileSync(join(cwd, ".agents/skills/creator/SKILL.md"), "---\nname: creator\ndescription: Test creator\n---\nCreate test notes.\n");
  const document = (name: string, marker: string) => writeFileSync(join(docs, "notes/one", name), `---\ndescription: ${marker}\n---\n## Required\nDetails.\n`);
  const createDocs = (marker: string) => {
    mkdirSync(join(docs, "notes/one"), { recursive: true });
    writeFileSync(join(docs, "NOTES.md"), '---\ndoc-manifest:\n  creator-skill: creator\n  validation:\n    required-sections: [Required]\n    filename-pattern: "{one,two}/**/*.md"\n---\nTest responsibility.\n');
    document("current.md", marker);
  };
  createDocs("REFRESH_V1");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 } }));
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const manager = SessionManager.inMemory(cwd);
  manager.appendCustomEntry("doc-manifests", { version: 1, content: "STALE_LEGACY_SNAPSHOT" });
  let requests = 0;
  let compactions = 0;
  const errors: unknown[] = [];
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings,
    additionalExtensionPaths: ["pi-doc-manifests", "pi-subagent", "pi-system-reminders"].map(name => join(root, "extensions", name, "index.ts")),
    extensionFactories: [pi => {
      pi.on("before_agent_start", event => { event.systemPromptOptions.sections.fixture = "UNRELATED_SECTION"; });
      pi.on("session_before_compact", event => {
        compactions++;
        return { compaction: { summary: "Deterministic summary without a manifest.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
      });
      pi.registerTool({ name: "update_docs", label: "Update fixture", description: "Update controlled documentation fixtures", parameters: Type.Object({}),
        async execute() {
          if (requests === 1) { document("current.md", "REFRESH_V2"); document("added.md", "REFRESH_ADDED"); }
          else { assert.equal(requests, 2); rmSync(join(docs, "notes/one/current.md")); }
          return { content: [{ type: "text", text: "Fixture updated" }], details: {} };
        },
      });
      pi.registerProvider("steel-doc-refresh", {
        api: "steel-doc-refresh", apiKey: "local-fixture", baseUrl: "http://invalid.invalid",
        models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(model, context) {
          requests++;
          assert(requests <= 7, "Unexpected model continuation");
          const prompt = getCurrentSystemPrompt(context.messages);
          assert(prompt.includes("UNRELATED_SECTION"));
          assert(prompt.includes("<id>reviewer</id>"), "subagent guidance survives");
          assert(prompt.includes("## System reminders"), "reminder guidance survives");
          assert(!prompt.includes("STALE_LEGACY_SNAPSHOT"));
          assert(!prompt.includes("## Diagnostics"));
          const names = getCurrentTools(context.messages).map(tool => tool.name);
          assert(names.includes("update_docs") && names.includes("read") && names.includes("subagent"));
          assert.equal((prompt.match(/<docs-manifest>/g) ?? []).length, requests === 6 ? 0 : 1);
          if (requests === 1) assert(prompt.includes("REFRESH_V1"));
          if (requests === 2) { assert(prompt.includes("REFRESH_V2") && prompt.includes("REFRESH_ADDED")); assert(!prompt.includes("REFRESH_V1")); }
          if (requests === 3) { assert(prompt.includes("REFRESH_ADDED")); assert(!prompt.includes("REFRESH_V2")); }
          if (requests === 4) assert(prompt.includes("REFRESH_COMPACT"));
          if (requests === 5) assert(prompt.includes("REFRESH_RELOAD"));
          if (requests === 7) assert(prompt.includes("REFRESH_RECREATED"));
          const message: AssistantMessage = { role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: Date.now(),
            content: requests <= 2 ? [{ type: "toolCall", id: `update-${requests}`, name: "update_docs", arguments: {} }] : [{ type: "text", text: "Verified" }],
            stopReason: requests <= 2 ? "toolUse" : "stop",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: requests <= 2 ? "toolUse" : "stop", message }); stream.end();
          return stream;
        },
      });
    }],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "model-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, sessionManager: manager });
  try {
    await session.bindExtensions({ onError: error => errors.push(error) });
    const model = modelRuntime.getModels().find(item => item.provider === "steel-doc-refresh");
    assert(model); await session.setModel(model);
    const records = () => manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "doc-manifests").length;
    const initialRecords = records();
    await session.prompt("Update and check the documentation fixtures.");
    assert.equal(requests, 3, JSON.stringify({ errors, responses: session.messages.filter(message => message.role === "assistant") }));
    assert.equal(records(), initialRecords, "tool-loop refreshes add no display history");
    document("added.md", "REFRESH_COMPACT");
    await session.compact();
    assert.equal(compactions, 1);
    assert.equal(records(), initialRecords, "compaction adds no manifest entry");
    await session.prompt("Check after compaction.");
    assert.equal(requests, 4);
    document("added.md", "REFRESH_RELOAD");
    await session.reload();
    await session.prompt("Check after reload.");
    assert.equal(requests, 5);
    rmSync(docs, { recursive: true });
    await session.prompt("Check removed documentation.");
    assert.equal(requests, 6);
    createDocs("REFRESH_RECREATED");
    await session.prompt("Check recreated documentation.");
    assert.equal(requests, 7);
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.deepEqual(errors, []);
    assert.equal(session.getLastAssistantText(), "Verified");
    console.log(`Manifest refresh verified: ${requests} requests`);
  } finally { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
}
