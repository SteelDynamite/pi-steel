import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { discoverAgents, resolveLocationalAgentId, scanLocationalAgents } from "../agents.ts";
import { ADVERTISE_LOCATIONAL_AGENTS_ENV, CURRENT_LOCATIONAL_ROOT_ENV, ORCHESTRATED_CHILD_ENV } from "../constants.ts";
import { resolveAgent } from "../execution.ts";
import subagentExtension from "../index.ts";
import { getGuardedLocationalRoots } from "../locational-guard.ts";
import { makeLocationalManifest } from "../locational-manifest.ts";

delete process.env.HC_TERMINAL_ID;
process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS = "1";

const repo = fileURLToPath(new URL("..", import.meta.url));
const envKeys = ["PI_CODING_AGENT_DIR", CURRENT_LOCATIONAL_ROOT_ENV, ORCHESTRATED_CHILD_ENV, ADVERTISE_LOCATIONAL_AGENTS_ENV];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let root;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-subagent-behavioral-boundaries-"));
	for (const key of envKeys) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = join(root, "user");
});
afterEach(() => {
	for (const key of envKeys) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
	rmSync(root, { recursive: true, force: true });
});

function define(dir, frontmatter = "description: Fixture") {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SUBAGENTS.md"), `---\n${frontmatter}\n---\nDefinition body\n`);
	return dir;
}

function extension() {
	const handlers = new Map();
	const entries = [];
	subagentExtension({
		on(name, handler) { handlers.set(name, handler); },
		registerCommand() {}, registerTool() {}, registerEntryRenderer() {},
		appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
	});
	return { handlers, entries };
}

function context(cwd, entries = []) {
	return {
		cwd, mode: "tui", hasUI: false, isProjectTrusted: () => true,
		sessionManager: { getBranch: () => entries, buildContextEntries: () => entries },
	};
}

const promptEvent = { systemPrompt: "base", systemPromptOptions: { contextFiles: [], selectedTools: [], toolSnippets: {} } };

test("bundled agents need no project link or root owner: IDs, manifest, prompt, and edit guard", async () => {
	const discovery = discoverAgents(repo, true);
	assert.deepEqual(discovery.errors, []);
	assert.equal(discovery.projectAgentsDir, null);
	assert.deepEqual(discovery.locationalAgents, []);
	assert.equal(makeLocationalManifest(discovery.locationalAgents), undefined);
	for (const id of ["reviewer", "scout", "worker"]) {
		assert.equal(discovery.agents.find((agent) => agent.id === id).origin, "bundled");
		assert.equal(resolveAgent(repo, discovery.agents, id).kind, "behavioral");
		assert.equal(resolveLocationalAgentId(repo, `agents/${id}`), null);
		assert.equal(resolveLocationalAgentId(repo, join(repo, "agents", id)), null);
	}
	// The imported module has bundled companions, not project links or a locational owner.
	assert.deepEqual(getGuardedLocationalRoots(repo), []);
	const { handlers, entries } = extension();
	const ctx = context(repo, entries);
	await handlers.get("session_start")({}, ctx);
	assert.deepEqual(entries, []);
	const prompt = await handlers.get("before_agent_start")(promptEvent, ctx);
	assert.match(prompt.systemPrompt, /<id>reviewer<\/id>/);
	assert.doesNotMatch(prompt.systemPrompt, /## Available locational agents|Subagent configuration errors:/);
	for (const toolName of ["read", "edit", "write"]) {
		assert.equal(await handlers.get("tool_call")({ toolName, input: { path: "agents/reviewer/SUBAGENTS.md" } }, ctx), undefined);
	}
	assert.equal(await handlers.get("tool_call")({ toolName: "bash", input: { command: "git diff -- agents/reviewer/SUBAGENTS.md" } }, ctx), undefined);
});

test("monorepo ancestor scans exclude bundled companions without project symlinks", async () => {
	const moduleRoot = join(root, "extensions", "pi-subagent");
	const ids = ["reviewer", "scout", "worker"];
	for (const id of ids) {
		const dir = join(moduleRoot, "agents", id);
		mkdirSync(dir, { recursive: true });
		copyFileSync(join(repo, "agents", id, "SUBAGENTS.md"), join(dir, "SUBAGENTS.md"));
	}
	for (const file of ["agents.ts", "pi-compat.ts", "locational-guard.ts", "constants.ts"]) {
		copyFileSync(join(repo, file), join(moduleRoot, file));
	}
	writeFileSync(join(moduleRoot, "package.json"), '{"type":"module"}');
	const loaded = await import(pathToFileURL(join(moduleRoot, "agents.ts")).href);
	const guard = await import(pathToFileURL(join(moduleRoot, "locational-guard.ts")).href);
	const owner = define(join(root, "extensions", "other", "agents", "reviewer"));
	const discovery = loaded.discoverAgents(root, true);
	assert.equal(discovery.projectAgentsDir, null);
	assert.deepEqual(discovery.errors, []);
	assert.deepEqual(discovery.locationalAgents.map((agent) => agent.rootDir), [owner]);
	assert.deepEqual(guard.getGuardedLocationalRoots(root), [owner]);
	for (const id of ids) {
		assert.equal(discovery.agents.find((agent) => agent.id === id).origin, "bundled");
		assert.equal(loaded.resolveLocationalAgentId(root, join(moduleRoot, "agents", id)), null);
	}
});

test("bundled roots use the loaded module; a separate source checkout requires an explicit project root", async () => {
	const installed = join(root, "installed");
	const bundled = define(join(installed, "agents", "reviewer"));
	for (const file of ["agents.ts", "pi-compat.ts", "constants.ts"]) copyFileSync(join(repo, file), join(installed, file));
	writeFileSync(join(installed, "package.json"), '{"type":"module"}');
	const loaded = await import(pathToFileURL(join(installed, "agents.ts")).href);
	const discovery = loaded.discoverAgents(installed, true);
	assert.equal(discovery.agents.find((agent) => agent.id === "reviewer").origin, "bundled");
	assert.deepEqual(discovery.locationalAgents, []);
	assert.equal(loaded.resolveLocationalAgentId(installed, bundled), null);

	const checkout = join(root, "checkout");
	const definition = define(join(checkout, "agents", "reviewer"));
	assert.equal(loaded.resolveLocationalAgentId(checkout, definition).kind, "locational");
	mkdirSync(join(checkout, ".agents"));
	symlinkSync("../agents", join(checkout, ".agents", "subagents"), "dir");
	const configured = loaded.discoverAgents(checkout, true);
	assert.equal(configured.agents.find((agent) => agent.id === "reviewer").origin, "project");
	assert.deepEqual(configured.locationalAgents, []);
	assert.equal(loaded.resolveLocationalAgentId(checkout, definition), null);
	assert.deepEqual(getGuardedLocationalRoots(checkout), []);
});

test("user and both CWD project slots are behavioral-only; same names elsewhere stay locational", async () => {
	const user = define(join(root, "user", "agents", "reviewer"));
	const portable = define(join(root, ".agents", "subagents", "reviewer"));
	const project = define(join(root, ".pi", "agents", "reviewer"));
	const ordinary = define(join(root, "agents", "reviewer"));
	const nested = define(join(root, "nested", ".agents", "subagents", "reviewer"));
	const hidden = define(join(root, "hidden"), "description: Hidden owner\nmanifest: false");
	const expected = [ordinary, nested, hidden].map((dir) => realpathSync.native(dir)).sort();
	const discovery = discoverAgents(root, true);
	assert.equal(discovery.projectAgentsDir, join(root, ".pi", "agents"));
	assert.equal(discovery.agents.find((agent) => agent.id === "reviewer").rootDir, project);
	assert.deepEqual(discovery.locationalAgents.map((agent) => agent.rootDir).sort(), expected);
	assert.deepEqual(getGuardedLocationalRoots(root).sort(), expected);
	for (const dir of [user, portable, project]) assert.equal(resolveLocationalAgentId(root, dir), null);
	for (const dir of [ordinary, nested, hidden]) assert.equal(resolveLocationalAgentId(root, dir).kind, "locational");
	const { handlers, entries } = extension();
	const ctx = context(root, entries);
	await handlers.get("session_start")({}, ctx);
	assert.equal(entries.length, 1);
	assert.ok(entries[0].data.content.includes(ordinary));
	assert.ok(entries[0].data.content.includes(nested));
	for (const dir of [user, portable, project, hidden]) assert.equal(entries[0].data.content.includes(dir), false);
	for (const dir of [user, portable, project, ordinary, nested, hidden]) {
		const result = await handlers.get("tool_call")({ toolName: "edit", input: { path: join(dir, "SUBAGENTS.md") } }, ctx);
		assert.equal(Boolean(result?.block), [ordinary, nested, hidden].includes(dir));
	}
	// Trust does not turn project definitions into locational roots.
	assert.equal(discoverAgents(root, false).agents.find((agent) => agent.id === "reviewer").origin, "user");
});

test("symlinked behavioral definitions exclude only their target trees, including overridden and invalid definitions", () => {
	const userAgents = join(root, "user", "agents");
	mkdirSync(userAgents, { recursive: true });
	const target = define(join(root, "storage", "reviewer"));
	const invalid = define(join(root, "storage", "invalid"), "thinking: unsupported");
	const owned = define(join(root, "storage", "owned"));
	const nested = define(join(root, "storage", "not-a-definition", "nested"));
	symlinkSync(target, join(userAgents, "reviewer"), "dir");
	symlinkSync(invalid, join(userAgents, "invalid"), "dir");
	symlinkSync(join(root, "storage", "not-a-definition"), join(userAgents, "empty"), "dir");
	symlinkSync(target, join(root, "alias"), "dir");
	define(join(root, ".agents", "subagents", "reviewer"));
	const discovery = discoverAgents(root, true);
	assert.equal(discovery.agents.find((agent) => agent.id === "reviewer").origin, "project");
	assert.equal(discovery.errors.length, 1);
	assert.match(discovery.errors[0], /unsupported thinking level/);
	assert.deepEqual(discovery.locationalAgents.map((agent) => agent.rootDir).sort(), [owned, nested].sort());
	assert.deepEqual(getGuardedLocationalRoots(root).sort(), [owned, nested].sort());
	for (const dir of [target, invalid, join(userAgents, "reviewer"), join(root, "alias")]) assert.equal(resolveLocationalAgentId(root, dir), null);
	unlinkSync(join(userAgents, "reviewer"));
	assert.equal(resolveLocationalAgentId(root, target).kind, "locational");
	assert.ok(scanLocationalAgents(root).agents.some((agent) => agent.rootDir === target));
});

test("symlinked behavioral containers exclude their canonical trees without excluding adjacent owners", () => {
	for (const slot of [join(root, "user", "agents"), join(root, ".pi", "agents"), join(root, ".agents", "subagents")]) {
		const store = mkdtempSync(join(root, "definitions-"));
		const definition = define(join(store, "reviewer"));
		mkdirSync(resolve(slot, ".."), { recursive: true });
		symlinkSync(store, slot, "dir");
		assert.equal(resolveLocationalAgentId(root, definition), null);
		assert.equal(resolveLocationalAgentId(root, join(slot, "reviewer")), null);
		assert.equal(scanLocationalAgents(root).agents.some((agent) => agent.rootDir === definition), false);
	}
	const ordinary = define(join(root, "definitions-adjacent", "reviewer"));
	assert.deepEqual(getGuardedLocationalRoots(root), [ordinary]);
});

test("containing guards skip behavioral definitions but keep the genuine source ancestor", () => {
	define(root);
	const behavioral = define(join(root, "user", "agents", "reviewer"));
	const work = join(behavioral, "notes");
	mkdirSync(work);
	assert.deepEqual(getGuardedLocationalRoots(work), [realpathSync.native(root)]);
	process.env[CURRENT_LOCATIONAL_ROOT_ENV] = root;
	assert.deepEqual(getGuardedLocationalRoots(work), []);
});

test("starting inside a bundled definition does not inject it as local owner instructions", async () => {
	const { handlers } = extension();
	const prompt = await handlers.get("before_agent_start")(promptEvent, context(join(repo, "agents", "reviewer")));
	assert.doesNotMatch(prompt.systemPrompt, /You are a senior code reviewer|Do NOT modify files/);
	assert.match(prompt.systemPrompt, /<id>reviewer<\/id>/);
});
