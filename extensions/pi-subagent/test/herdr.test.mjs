import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import subagentExtension from "../index.ts";

beforeEach(() => {
	for (const key of ["HC_TERMINAL_ID", "HERDR_ENV", "PI_ORCHESTRATED_CHILD", "PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS"]) delete process.env[key];
});

async function register(result = { code: 0, stdout: "# hc manual (herdr-core)", stderr: "" }) {
	const handlers = new Map();
	const commands = new Map();
	const tools = [];
	const probes = [];
	const notices = [];
	await subagentExtension({
		on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand(name, command) { commands.set(name, command); },
		registerTool(tool) { tools.push(tool); },
		registerEntryRenderer() {},
		appendEntry() {},
		async exec(...args) {
			probes.push(args);
			if (result instanceof Error) throw result;
			return result;
		},
	});
	const ctx = {
		hasUI: true, mode: "tui", cwd: process.cwd(), isProjectTrusted: () => false,
		sessionManager: { getBranch: () => [], buildContextEntries: () => [], getSessionId: () => "herdr-test" },
		ui: { notify: (...args) => notices.push(args) },
	};
	const start = async () => { for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx); };
	return { handlers, commands, tools, probes, notices, ctx, start };
}

for (const id of [undefined, "", "  "]) test(`no hc identity (${JSON.stringify(id)}): native delegation without a probe`, async () => {
	if (id !== undefined) process.env.HC_TERMINAL_ID = id;
	process.env.HERDR_ENV = "1"; // The older Herdr TUI is not hc.
	const result = await register();
	assert.deepEqual(result.probes, []);
	assert.deepEqual(result.tools.map(tool => tool.name), ["subagent"]);
	assert.equal(result.tools[0].exposure, "model-only");
	assert(result.commands.has("subagent-settings"));
	assert(!result.handlers.has("resources_discover"));
	await result.start();
	assert.deepEqual(result.notices, []);
});

for (const child of [false, true]) test(`hc handoff registers only its skill (child=${child})`, async () => {
	process.env.HC_TERMINAL_ID = "t7";
	if (child) process.env.PI_ORCHESTRATED_CHILD = "1";
	const result = await register();
	assert.deepEqual(result.probes, [["hc", ["--skill"], { timeout: 3000, maxBuffer: 256 * 1024 }]]);
	assert.deepEqual(result.tools, []);
	assert.equal(result.commands.size, 0);
	assert.deepEqual([...result.handlers.keys()], ["resources_discover"]);
	const resources = result.handlers.get("resources_discover")[0]();
	assert.equal(resources.skillPaths.length, 1);
	assert(existsSync(resources.skillPaths[0]));
	const skill = readFileSync(resources.skillPaths[0], "utf8");
	assert.match(skill, /name: herdr-delegation/);
	assert.match(skill, /hc --skill/);
	assert.match(skill, /PI_ORCHESTRATED_CHILD=1/);
	assert.match(skill, /PI_CODING_AGENT_DIR/);
	assert.match(skill, /not automatically inherited/);
	assert.deepEqual(result.notices, []);
});

for (const failure of [
	new Error("spawn hc ENOENT"),
	{ code: 1, stdout: "herdr-core", stderr: "\u001b[2Junsafe error" },
	{ code: 0, stdout: "", stderr: "" },
	{ code: 0, stdout: "another hc command", stderr: "" },
	{ code: 0, stdout: "herdr-core", killed: true },
	{ code: 0, stdout: "herdr-core", truncated: true },
]) test(`unusable hc retains native delegation and warns once: ${JSON.stringify(failure)}`, async () => {
	process.env.HC_TERMINAL_ID = "t7";
	const result = await register(failure);
	assert.equal(result.probes.length, 1);
	assert.deepEqual(result.tools.map(tool => tool.name), ["subagent"]);
	assert(result.commands.has("subagent-settings"));
	assert(result.handlers.has("before_agent_start"));
	assert(!result.handlers.has("resources_discover"));
	await result.start();
	await result.start();
	assert.equal(result.probes.length, 1, "no retry on session_start");
	assert.equal(result.notices.length, 1);
	assert.match(result.notices[0][0], /Keeping native subagents.*https:\/\/herdr.dev\/core\/.*\/reload/);
	assert.doesNotMatch(result.notices[0][0], /\u001b/);
	assert.equal(result.notices[0][1], "warning");
});

for (const mode of ["child", "print"]) test(`fallback stays quiet for ${mode}`, async () => {
	process.env.HC_TERMINAL_ID = "t7";
	if (mode === "child") process.env.PI_ORCHESTRATED_CHILD = "1";
	const result = await register(new Error("unavailable"));
	if (mode === "print") { result.ctx.hasUI = false; result.ctx.mode = "print"; }
	await result.start();
	assert.equal(result.tools[0].name, "subagent");
	assert.deepEqual(result.notices, []);
});

test("explicit locational guards prevent automatic handoff", async () => {
	process.env.HC_TERMINAL_ID = "t7";
	process.env.PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS = "1";
	const result = await register();
	assert.deepEqual(result.probes, []);
	assert.equal(result.tools[0].name, "subagent");
	assert(result.handlers.has("tool_call"));
	assert(!result.handlers.has("resources_discover"));
	await result.start();
	assert.match(result.notices[0][0], /locational guards/);
});
