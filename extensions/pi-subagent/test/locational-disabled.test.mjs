import assert from "node:assert/strict";
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { discoverAgents, resolveLocationalAgentId, scanLocationalAgents } from "../agents.ts";
import { ADVERTISE_LOCATIONAL_AGENTS_ENV, CURRENT_LOCATIONAL_ROOT_ENV, ENABLE_LOCATIONAL_AGENTS_ENV, LOCATIONAL_ANCESTOR_STACK_ENV, ORCHESTRATED_CHILD_ENV, locationalAgentsEnabled } from "../constants.ts";
import { makeSubagentChildEnv, resolveAgent, runDelegation } from "../execution.ts";
import subagentExtension from "../index.ts";
import { getGuardedLocationalRoots, getLocationalAncestorStack, getLocationalLoopError } from "../locational-guard.ts";
import { shouldAdvertiseLocationalAgents } from "../locational-manifest.ts";
import { useFakePi } from "./fixtures/pi-host.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const keys = [ENABLE_LOCATIONAL_AGENTS_ENV, ADVERTISE_LOCATIONAL_AGENTS_ENV, CURRENT_LOCATIONAL_ROOT_ENV, LOCATIONAL_ANCESTOR_STACK_ENV, ORCHESTRATED_CHILD_ENV, "PI_CODING_AGENT_DIR", "PI_SUBAGENT_DEPTH"];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let root;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-subagent-disabled-"));
	for (const key of keys) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = join(root, "user");
});
afterEach(() => {
	for (const key of keys) {
		if (original[key] === undefined) delete process.env[key];
		else process.env[key] = original[key];
	}
	rmSync(root, { recursive: true, force: true });
});

function register(extension = subagentExtension) {
	const handlers = new Map();
	const entries = [];
	let tool;
	extension({
		on(name, handler) { handlers.set(name, handler); },
		registerCommand() {}, registerEntryRenderer() {},
		registerTool(value) { tool = value; },
		appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
	});
	return { handlers, entries, tool };
}
function context(cwd, entries = []) {
	return { cwd, mode: "tui", hasUI: false, isProjectTrusted: () => true,
		sessionManager: { getBranch: () => entries, buildContextEntries: () => entries } };
}
const event = { systemPrompt: "base", systemPromptOptions: { contextFiles: [], selectedTools: [], toolSnippets: {} } };

test("only exact 1 enables locational agents; stale ownership and advertisement cannot enable them", async () => {
	const owned = join(root, "owned");
	mkdirSync(owned);
	writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owner\n---\nOWNER INSTRUCTIONS\n");
	process.env[CURRENT_LOCATIONAL_ROOT_ENV] = owned;
	process.env[LOCATIONAL_ANCESTOR_STACK_ENV] = JSON.stringify([owned]);
	process.env[ADVERTISE_LOCATIONAL_AGENTS_ENV] = "1";
	for (const value of [undefined, "0", "true", "yes", " 1", "1 "]) {
		if (value === undefined) delete process.env[ENABLE_LOCATIONAL_AGENTS_ENV];
		else process.env[ENABLE_LOCATIONAL_AGENTS_ENV] = value;
		assert.equal(locationalAgentsEnabled(), false);
		assert.equal(shouldAdvertiseLocationalAgents(), false);
		assert.deepEqual(scanLocationalAgents(root), { agents: [], errors: [], roots: [] });
		assert.deepEqual(discoverAgents(root, true, { includeLocationalAgents: true }).locationalAgents, []);
		assert.equal(resolveLocationalAgentId(root, "owned"), null);
		assert.equal(resolveAgent(root, [], owned), undefined);
		assert.deepEqual(getGuardedLocationalRoots(owned), []);
		assert.deepEqual(getLocationalAncestorStack(), []);
		assert.equal(getLocationalLoopError({ kind: "locational", rootDir: owned }), undefined);
		const { handlers, entries, tool } = register();
		assert.equal(tool.exposure, "model-only");
		assert.match(tool.description, /Locational agents are disabled/);
		const ctx = context(owned, entries);
		for (const name of ["session_start", "session_tree", "session_compact"]) await handlers.get(name)({}, ctx);
		assert.deepEqual(entries, []);
		const prompt = await handlers.get("before_agent_start")(event, ctx);
		assert.match(prompt.systemPrompt, /<id>worker<\/id>/);
		assert.doesNotMatch(prompt.systemPrompt, /OWNER INSTRUCTIONS|Available locational agents|configuration errors/);
		for (const toolName of ["read", "write", "edit", "bash"]) {
			assert.equal(await handlers.get("tool_call")({ toolName, input: { path: join(owned, "file"), command: "cat file" } }, ctx), undefined);
		}
		const result = await tool.execute("id", { id: owned, session: "new", task: "work", includeLocationalAgents: true }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Unknown subagent id/);
		assert.equal(result.details.includeLocationalAgents, false);
	}
	process.env[ENABLE_LOCATIONAL_AGENTS_ENV] = "1";
	assert.equal(locationalAgentsEnabled(), true);
	assert.equal(resolveLocationalAgentId(root, "owned").kind, "locational");
});

test("behavioral child delegation works and includeLocationalAgents cannot override default-off", async () => {
	process.env[CURRENT_LOCATIONAL_ROOT_ENV] = root;
	process.env[LOCATIONAL_ANCESTOR_STACK_ENV] = JSON.stringify([root]);
	process.env[ADVERTISE_LOCATIONAL_AGENTS_ENV] = "1";
	const agent = { id: "fixture", kind: "behavioral", origin: "user", rootDir: root, filePath: join(root, "SUBAGENTS.md"), systemPrompt: "", resumable: false };
	const env = makeSubagentChildEnv(agent, 0, true);
	assert.equal(env[ADVERTISE_LOCATIONAL_AGENTS_ENV], "0");
	assert.equal(env[CURRENT_LOCATIONAL_ROOT_ENV], "");
	assert.equal(env[LOCATIONAL_ANCESTOR_STACK_ENV], "");
	assert.equal(env[ORCHESTRATED_CHILD_ENV], "1");
	const script = join(root, "child.cjs");
	writeFileSync(script, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(), enabled: process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS, advertise: process.env.PI_SUBAGENT_ADVERTISE_LOCATIONAL_AGENTS, owner: process.env.PI_SUBAGENT_LOCATIONAL_ROOT, stack: process.env.PI_SUBAGENT_LOCATIONAL_STACK, child: process.env.PI_ORCHESTRATED_CHILD }) }] } }));`);
	const restore = useFakePi(root, script);
	try {
		const result = await runDelegation({ appendEntry() {} }, { ...context(root), modelRegistry: { getAvailable: () => [] } }, root, [agent], agent.id, "new", "work", undefined, undefined, (results) => ({ results }), true);
		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.messages[0].content[0].text), { cwd: root, advertise: "0", owner: "", stack: "", child: "1" });
	} finally { restore(); }
});

test("installed extension scanning a separate source checkout has no default locational errors", async () => {
	const installed = join(root, "installed");
	mkdirSync(installed);
	for (const file of readdirSync(repo).filter((name) => name.endsWith(".ts") || name === "package.json")) copyFileSync(join(repo, file), join(installed, file));
	cpSync(join(repo, "agents"), join(installed, "agents"), { recursive: true });
	symlinkSync(join(repo, "node_modules"), join(installed, "node_modules"), "dir");
	const checkout = join(root, "checkout");
	const source = join(checkout, "extensions", "pi-subagent");
	cpSync(join(repo, "agents"), join(source, "agents"), { recursive: true });
	const loaded = await import(pathToFileURL(join(installed, "agents.ts")).href);
	const extension = (await import(pathToFileURL(join(installed, "index.ts")).href)).default;
	const discovery = loaded.discoverAgents(checkout, true);
	assert.deepEqual(discovery.errors, []);
	assert.deepEqual(discovery.locationalAgents, []);
	assert.deepEqual(discovery.agents.map((agent) => agent.id).sort(), ["reviewer", "scout", "worker"]);
	const { handlers, entries } = register(extension);
	const ctx = context(checkout, entries);
	await handlers.get("session_start")({}, ctx);
	assert.deepEqual(entries, []);
	const prompt = await handlers.get("before_agent_start")(event, ctx);
	assert.doesNotMatch(prompt.systemPrompt, /Available locational agents|configuration errors/);
	assert.equal(await handlers.get("tool_call")({ toolName: "edit", input: { path: join(source, "agents", "reviewer", "SUBAGENTS.md") } }, ctx), undefined);
	// Explicit opt-in retains module-relative discovery; no broad agents/ exclusion hides this case.
	process.env[ENABLE_LOCATIONAL_AGENTS_ENV] = "1";
	assert.match(loaded.discoverAgents(checkout, true).errors.join("\n"), /only for behavioral agents/);
});
