import assert from "node:assert/strict";
import { useFakePi } from "./fixtures/pi-host.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAgents } from "../agents.ts";
import { resolveAgentModel, runDelegation } from "../execution.ts";
import { subagentSettings, trackedSessions } from "../state.ts";

const defaults = [
	["scout", "gpt-6-luna", "low", "gpt-6.1-sol"],
	["worker", "gpt-6.1-sol", "medium", "gpt-6.1-sol"],
	["reviewer", "gpt-6-astra", "xhigh", "gpt-6-astra"],
];
const available = defaults.map(([_id, id]) => ({ provider: "openai", id, contextWindow: 2000 }));
const caller = (id = "gpt-6-astra", provider = "alternate") => ({ provider, id, contextWindow: 4000 });
const context = (model) => ({ model, modelRegistry: { getAvailable: () => available } });
const details = (results) => ({ includeLocationalAgents: false, locationalAgents: [], results });

test("bundled caller rules pin both matching callers to OpenAI and preserve unrelated defaults", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-caller-models-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = root;
		const discovery = discoverAgents(root, false, { includeLocationalAgents: false });
		assert.deepEqual(discovery.errors, []);
		for (const [id, model, thinking, target] of defaults) {
			const agent = discovery.agents.find((item) => item.id === id);
			const original = structuredClone(agent);
			assert.equal(agent.resumable, false);
			assert.equal(agent.model, `openai/${model}`);
			assert.equal(agent.thinking, undefined);
			assert.deepEqual(agent.whenCallerModelId, ["gpt-6-astra", "gpt-6.1-sol"]);
			assert.equal(agent.thenModel, `openai/${target}`);
			for (const provider of ["openai", "alternate"]) {
				for (const modelId of ["gpt-6-astra", "gpt-6.1-sol"]) {
					assert.deepEqual(resolveAgentModel(agent, context(caller(modelId, provider))), {
						model: `openai/${target}`, thinking, contextWindow: 2000, source: "agent",
						fallbackModel: `${provider}/${modelId}`, fallbackContextWindow: 4000,
					});
				}
			}
			for (const modelId of ["other", "GPT-6-ASTRA", "GPT-6.1-SOL", "gpt-6-astra-extra", "gpt-6.1-sol-extra", "openai/gpt-6-astra", "openai/gpt-6.1-sol", undefined]) {
				const resolved = resolveAgentModel(agent, context(modelId === undefined ? undefined : caller(modelId)));
				assert.equal(resolved.model, `openai/${model}`);
				assert.equal(resolved.thinking, undefined);
				assert.equal(resolved.source, "agent");
			}
			// Use the bundled worker's selected Sol as the actual immediate caller of each role.
			const worker = discovery.agents.find((item) => item.id === "worker");
			const outer = resolveAgentModel(worker, context(caller()));
			const nestedCaller = available.find((item) => `${item.provider}/${item.id}` === outer.model);
			assert.equal(nestedCaller.id, "gpt-6.1-sol");
			const nested = resolveAgentModel(agent, context(nestedCaller));
			assert.equal(nested.model, `openai/${target}`);
			assert.equal(nested.thinking, thinking);
			assert.deepEqual(agent, original);
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("caller rules use the immediate context on every nested delegation, never agent names", () => {
	const agent = { kind: "behavioral", id: "custom", model: "openai/gpt-6-luna", thinking: "high", whenCallerModelId: "gpt-6-astra", thenModel: "caller", thenThinking: "off" };
	const outer = context(caller());
	assert.equal(resolveAgentModel(agent, outer).thinking, "off");
	// An intervening agent chose Sol; its nested call must not inherit the original Astra rule.
	const inner = context(caller("gpt-6.1-sol"));
	assert.equal(resolveAgentModel(agent, inner).model, "openai/gpt-6-luna");
	assert.equal(resolveAgentModel(agent, inner).thinking, "high");
	inner.model = caller("gpt-6-astra", "nested-provider");
	assert.equal(resolveAgentModel(agent, inner).model, "nested-provider/gpt-6-astra");
	assert.equal(resolveAgentModel(agent, inner).thinking, "off");
	assert.equal(resolveAgentModel({ ...agent, kind: "locational" }, outer).thinking, "high");
	assert.equal(resolveAgentModel({ ...agent, kind: "locational" }, outer).model, "openai/gpt-6-luna");
	assert.equal(resolveAgentModel({ ...agent, whenCallerModelId: undefined, thenModel: undefined, thenThinking: undefined }, outer).thinking, "high");

	const unavailable = resolveAgentModel({ ...agent, model: "missing" }, inner);
	assert.equal(unavailable.model, "nested-provider/gpt-6-astra");
	assert.equal(unavailable.warning, undefined);
	const unmatched = resolveAgentModel({ ...agent, model: "missing" }, context(caller("other")));
	assert.equal(unmatched.model, "alternate/other");
	assert.equal(unmatched.thinking, "high");
	assert.match(unmatched.warning, /No configured model/);
	const inherited = resolveAgentModel({ ...agent, model: undefined }, context(caller("other")));
	assert.equal(inherited.model, "alternate/other");
	assert.equal(inherited.thinking, "high");
});

test("list rules use immediate caller identity, exact target provider, and existing unavailable-target fallback", () => {
	const agent = {
		kind: "behavioral", id: "custom-list", model: "openai/gpt-6-luna", thinking: "high",
		whenCallerModelId: ["gpt-6-astra", "gpt-6.1-sol"], thenModel: "openai/gpt-6.1-sol", thenThinking: "low",
	};
	const aliases = [caller("openai/gpt-6.1-sol"), caller("gpt-6.1-sol")];
	for (const modelId of agent.whenCallerModelId) {
		const ctx = { ...context(caller(modelId)), modelRegistry: { getAvailable: () => [...aliases, ...available] } };
		const resolved = resolveAgentModel(agent, ctx);
		assert.equal(resolved.model, "openai/gpt-6.1-sol");
		assert.equal(resolved.thinking, "low");
		const [provider, id] = resolved.model.split("/");
		const nested = resolveAgentModel(agent, context(caller(id, provider)));
		assert.equal(nested.model, "openai/gpt-6.1-sol");
		assert.equal(nested.thinking, "low");
		const inherited = resolveAgentModel({ ...agent, thenModel: "caller" }, ctx);
		assert.equal(inherited.model, `alternate/${modelId}`);
		assert.equal(inherited.source, "caller");
		assert.equal(inherited.contextWindow, 4000);

		// Neither a matching bare ID on another provider nor a literal selector as ID can satisfy the target.
		ctx.modelRegistry.getAvailable = () => aliases;
		const unavailable = resolveAgentModel(agent, ctx);
		assert.equal(unavailable.model, `alternate/${modelId}`);
		assert.equal(unavailable.thinking, "low");
		assert.equal(unavailable.source, "caller");
		assert.match(unavailable.warning, /No configured model from "openai\/gpt-6\.1-sol"/);
	}
	const unrelated = resolveAgentModel(agent, context(caller("other")));
	assert.equal(unrelated.model, "openai/gpt-6-luna");
	assert.equal(unrelated.thinking, "high");
	assert.equal(resolveAgentModel({ ...agent, kind: "locational" }, context(caller())).model, "openai/gpt-6-luna");
	const literalId = { ...agent, whenCallerModelId: ["vendor/model"], thenModel: "caller" };
	assert.equal(resolveAgentModel(literalId, context(caller("model", "vendor"))).thinking, "high");
	assert.equal(resolveAgentModel(literalId, context(caller("vendor/model"))).thinking, "low");
});

test("explicit caller targets preserve speed inheritance, resume effort, and behavioral no-retry", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-caller-launch-"));
	const restorePi = useFakePi(root, join(root, "fake-pi.cjs"));
	const envKeys = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_TEST_STATE_FILE", "PI_CHATGPT_SPEED", "PI_CHATGPT_FAST", "PI_SUBAGENT_DEPTH"];
	const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
	const originalReuse = subagentSettings.reuseEnabled;
	const originalTracked = new Map(trackedSessions);
	try {
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_CHATGPT_FAST = "0";
		trackedSessions.clear();
		subagentSettings.reuseEnabled = true;
		const stateFile = join(root, "calls.json");
		writeFileSync(stateFile, "[]");
		const piPath = join(root, "fake-pi.cjs");
		writeFileSync(piPath, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(process.env.PI_SUBAGENT_TEST_STATE_FILE, "utf8"));
calls.push({ args, speed: process.env.PI_CHATGPT_SPEED, fast: process.env.PI_CHATGPT_FAST, depth: process.env.PI_SUBAGENT_DEPTH });
fs.writeFileSync(process.env.PI_SUBAGENT_TEST_STATE_FILE, JSON.stringify(calls));
if (args.at(-1) === "Task: fail") { process.stderr.write("provider unavailable"); process.exit(1); }
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }));
`);
		process.env.PI_SUBAGENT_TEST_STATE_FILE = stateFile;
		const agents = discoverAgents(root, false, { includeLocationalAgents: false }).agents;
		const ctx = {
			...context(caller()), cwd: root, isProjectTrusted: () => true,
			sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
		};
		ctx.modelRegistry.isUsingOAuth = () => true;
		const expected = [];
		for (const speed of [undefined, "standard", "fast", "ultrafast"]) {
			if (speed === undefined) delete process.env.PI_CHATGPT_SPEED;
			else process.env.PI_CHATGPT_SPEED = speed;
			for (const modelId of ["gpt-6-astra", "gpt-6.1-sol", "other"]) {
				ctx.model = caller(modelId);
				const parent = structuredClone(ctx.model);
				for (const [id, baseModel, effort, target] of defaults) {
					const model = `openai/${modelId === "other" ? baseModel : target}`;
					const thinking = modelId === "other" ? undefined : effort;
					const result = await runDelegation({ appendEntry() {} }, ctx, root, agents, id, "new", "launch", undefined, undefined, details, false);
					assert.equal(result.exitCode, 0);
					assert.equal(result.model, model);
					assert.equal(result.agentThinking, thinking);
					assert.equal(result.requestedSpeed, speed === "ultrafast" && model !== "openai/gpt-6-luna" ? "ultrafast" : undefined);
					assert.deepEqual(ctx.model, parent);
					assert.equal(process.env.PI_CHATGPT_SPEED, speed);
					assert.equal(process.env.PI_CHATGPT_FAST, "0");
					expected.push({ model, thinking, speed });
				}
			}
		}
		const flag = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
		let calls = JSON.parse(readFileSync(stateFile, "utf8"));
		assert.deepEqual(calls.map(({ args, speed }) => ({ model: flag(args, "--model"), thinking: flag(args, "--thinking"), speed })), expected);
		assert.ok(calls.every(({ args, depth, fast }) => args.includes("--no-session") && !args.includes("--session-id") && depth === "2" && fast === "0"));

		const resumable = { ...agents.find((agent) => agent.id === "worker"), id: "custom-resumable", resumable: true, thinking: "high" };
		const resumeCases = [
			["new", caller(), "medium", "openai/gpt-6.1-sol", "openai/gpt-6.1-sol"],
			["resume", caller("gpt-6.1-sol", "nested-provider"), "medium", "openai/gpt-6.1-sol", "openai/gpt-6.1-sol"],
			["resume", caller("other"), "high", "openai/gpt-6.1-sol", "openai/gpt-6.1-sol"],
			["resume", caller(), "off", "alternate/gpt-6-astra", "caller"],
			["resume", caller("gpt-6.1-sol"), "off", "alternate/gpt-6.1-sol", "caller"],
			["resume", caller("other"), undefined, "openai/gpt-6.1-sol", "caller"],
		];
		for (const [session, model, thinking, expectedModel, target] of resumeCases) {
			ctx.model = model;
			resumable.thenModel = target;
			if (thinking === "off") resumable.thenThinking = "off";
			if (thinking === undefined) delete resumable.thinking;
			const result = await runDelegation({ appendEntry() {} }, ctx, root, [resumable], resumable.id, session, "resume", undefined, undefined, details, false);
			assert.equal(result.exitCode, 0);
			assert.equal(result.nextSessionIntent, "resume");
			assert.equal(result.model, expectedModel);
			assert.equal(result.agentThinking, thinking);
		}
		calls = JSON.parse(readFileSync(stateFile, "utf8"));
		const resumed = calls.slice(expected.length);
		assert.deepEqual(resumed.map(({ args }) => flag(args, "--thinking")), resumeCases.map((item) => item[2]));
		assert.deepEqual(resumed.map(({ args }) => flag(args, "--model")), resumeCases.map((item) => item[3]));
		assert.ok(flag(resumed[0].args, "--session-id"));
		assert.equal(new Set(resumed.map(({ args }) => flag(args, "--session-id"))).size, 1);

		ctx.model = caller();
		const wrong = await runDelegation({ appendEntry() {} }, ctx, root, agents, "scout", "resume", "wrong intent", undefined, undefined, details, false);
		assert.equal(wrong.agentThinking, "low");
		assert.equal(wrong.wrongSessionIntent.required, "new");
		const failure = await runDelegation({ appendEntry() {} }, ctx, root, agents, "worker", "new", "fail", undefined, undefined, details, false);
		assert.equal(failure.exitCode, 1);
		assert.equal(failure.warning, undefined);
		// Wrong intent launches nothing; behavioral failure launches exactly once.
		assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).length, calls.length + 1);
	} finally {
		restorePi();
		for (const [key, value] of originalEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		trackedSessions.clear();
		for (const [key, value] of originalTracked) trackedSessions.set(key, value);
		subagentSettings.reuseEnabled = originalReuse;
		rmSync(root, { recursive: true, force: true });
	}
});
