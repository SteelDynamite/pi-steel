import assert from "node:assert/strict";
import { useFakePi } from "./fixtures/pi-host.mjs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	ADVERTISE_LOCATIONAL_AGENTS_ENV,
	CURRENT_LOCATIONAL_ROOT_ENV,
	LOCATIONAL_PREFERRED_MODELS_ENV,
	ORCHESTRATED_CHILD_ENV,
	SUBAGENT_DEPTH_ENV,
} from "../constants.ts";
import {
	classifyContextLimitFailure,
	findContextLimitEvidence,
	makeSubagentChildEnv,
	resolveAgentModel,
	runDelegation,
	shouldRetryPreferredModelFailure,
} from "../execution.ts";
import { subagentSettings, trackedSessions } from "../state.ts";

function agent(kind) {
	return {
		id: kind,
		description: "",
		manifest: true,
		systemPrompt: "",
		origin: kind === "locational" ? "locational" : "user",
		kind,
		filePath: "/tmp/SUBAGENTS.md",
		rootDir: "/tmp/source-root",
		resumable: false,
	};
}

function modelContext(availableModels = [], currentModel = { provider: "caller", id: "default", contextWindow: 1000 }) {
	return { model: currentModel, modelRegistry: { getAvailable: () => availableModels } };
}

function delegationContext(root, availableModels, currentModel = { provider: "caller", id: "default", contextWindow: 1000 }) {
	return {
		ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: () => undefined },
		hasUI: false,
		mode: "json",
		cwd: root,
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
		model: currentModel,
		modelRegistry: { getAvailable: () => availableModels },
	};
}

const details = (results) => ({ includeLocationalAgents: false, locationalAgents: [], results });

test("makeSubagentChildEnv sets only current subagent and orchestrated markers", () => {
	const behavioral = makeSubagentChildEnv(agent("behavioral"), 2, false);
	assert.equal(behavioral[SUBAGENT_DEPTH_ENV], "3");
	assert.equal(behavioral[ORCHESTRATED_CHILD_ENV], "1");
	assert.equal(behavioral[ADVERTISE_LOCATIONAL_AGENTS_ENV], "0");
	assert.equal(behavioral.PI_SUBPROCESS_CHILD, undefined);

	const locational = makeSubagentChildEnv(agent("locational"), 0, false);
	assert.equal(locational[SUBAGENT_DEPTH_ENV], "1");
	assert.equal(locational[ADVERTISE_LOCATIONAL_AGENTS_ENV], "1");
	assert.equal(locational[CURRENT_LOCATIONAL_ROOT_ENV], resolve("/tmp/source-root"));
});

test("resolveAgentModel uses explicit candidates and falls back to caller when unavailable", () => {
	const local = { ...agent("locational"), model: "missing, explicit" };
	const resolved = resolveAgentModel(local, modelContext([{ provider: "provider", id: "explicit", contextWindow: 2000 }]));
	assert.equal(resolved.model, "provider/explicit");
	assert.equal(resolved.contextWindow, 2000);
	assert.equal(resolved.source, "agent");
	assert.equal(resolved.fallbackModel, "caller/default");

	const unavailable = resolveAgentModel({ ...local, model: "missing" }, modelContext([]));
	assert.equal(unavailable.model, "caller/default");
	assert.equal(unavailable.source, "caller");
	assert.match(unavailable.warning, /No configured model/);
});

test("resolveAgentModel pins qualified selectors to their provider without changing thinking", () => {
	const ctx = modelContext([
		{ provider: "other", id: "gpt-6-luna", contextWindow: 1000 },
		{ provider: "openai", id: "gpt-6-luna", contextWindow: 2000 },
	]);
	for (const kind of ["behavioral", "locational"]) {
		const definition = { ...agent(kind), model: "openai/gpt-6-luna", thinking: "high" };
		const resolved = resolveAgentModel(definition, ctx);
		assert.equal(resolved.model, "openai/gpt-6-luna");
		assert.equal(resolved.contextWindow, 2000);
		assert.equal(resolved.source, "agent");
		assert.equal(definition.thinking, "high");
	}
});

test("resolveAgentModel uses env-configured preferred models and empty env disables them", () => {
	const previous = process.env[LOCATIONAL_PREFERRED_MODELS_ENV];
	try {
		process.env[LOCATIONAL_PREFERRED_MODELS_ENV] = "missing, spark-alt";
		let resolved = resolveAgentModel(agent("locational"), modelContext([{ provider: "provider", id: "spark-alt", contextWindow: 3000 }]));
		assert.equal(resolved.model, "provider/spark-alt");
		assert.equal(resolved.source, "preferred");

		process.env[LOCATIONAL_PREFERRED_MODELS_ENV] = "";
		resolved = resolveAgentModel(agent("locational"), modelContext([{ provider: "provider", id: "spark-alt", contextWindow: 3000 }]));
		assert.equal(resolved.model, "caller/default");
		assert.equal(resolved.source, "caller");
	} finally {
		if (previous === undefined) delete process.env[LOCATIONAL_PREFERRED_MODELS_ENV];
		else process.env[LOCATIONAL_PREFERRED_MODELS_ENV] = previous;
	}
});

test("context-limit failures are classified distinctly", () => {
	assert.match(findContextLimitEvidence("context_length_exceeded: maximum context length is 128000 tokens") ?? "", /context_length_exceeded/);
	const result = {
		exitCode: 1,
		stderr: "BadRequest: This model's maximum context length is 128000 tokens. However, your messages resulted in 140000 tokens.",
		messages: [],
		model: "provider/spark",
		contextWindow: 128000,
	};
	assert.equal(classifyContextLimitFailure(result), true);
	assert.equal(result.stopReason, "context_limit");
	assert.match(result.errorMessage, /Subagent hit context limit for provider\/spark \(128k context window\)/);
});

test("preferred-model retries are limited to conservative pre-work failures", () => {
	assert.equal(shouldRetryPreferredModelFailure({ exitCode: 1, stderr: "429 rate limit", messages: [] }), true);
	assert.equal(shouldRetryPreferredModelFailure({ exitCode: 1, stopReason: "context_limit", stderr: "", messages: [] }), true);
	assert.equal(shouldRetryPreferredModelFailure({
		exitCode: 1,
		stderr: "429 rate limit",
		messages: [{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }] }],
	}), false);
	assert.equal(shouldRetryPreferredModelFailure({ exitCode: 1, stderr: "tests failed", messages: [] }), false);
});

test("runDelegation retries a locational model in the same session", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-fallback-"));
	const restorePi = useFakePi(root, join(root, "fake-pi.cjs"));
	const originalState = process.env.PI_SUBAGENT_TEST_STATE_FILE;
	const originalLegacyMarker = process.env.PI_SUBPROCESS_CHILD;
	try {
		delete process.env.PI_SUBPROCESS_CHILD;
		const agentRoot = join(root, "loc-agent");
		mkdirSync(agentRoot);
		writeFileSync(join(agentRoot, "SUBAGENTS.md"), "---\nmodel: provider/explicit\nthinking: high\nresumable: false\n---\n");
		const stateFile = join(root, "state.json");
		writeFileSync(stateFile, "[]");
		const piPath = join(root, "fake-pi.cjs");
		writeFileSync(piPath, `
const fs = require("node:fs");
const stateFile = process.env.PI_SUBAGENT_TEST_STATE_FILE;
const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const sessionIndex = args.indexOf("--session-id");
const call = {
  model: modelIndex >= 0 ? args[modelIndex + 1] : "(default)",
  sessionId: sessionIndex >= 0 ? args[sessionIndex + 1] : "",
  thinking: args.includes("--thinking") ? args[args.indexOf("--thinking") + 1] : undefined,
  orchestrated: process.env.PI_ORCHESTRATED_CHILD,
  legacy: process.env.PI_SUBPROCESS_CHILD,
};
const calls = JSON.parse(fs.readFileSync(stateFile, "utf8"));
calls.push(call);
fs.writeFileSync(stateFile, JSON.stringify(calls));
if (call.model === "provider/explicit") {
  process.stderr.write("provider model unavailable");
  process.exit(1);
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok via " + call.model }] } }));
`);
		process.env.PI_SUBAGENT_TEST_STATE_FILE = stateFile;

		const result = await runDelegation(
			{ appendEntry: () => undefined },
			delegationContext(root, [{ provider: "provider", id: "explicit", contextWindow: 2000 }]),
			root,
			[],
			"loc-agent",
			"new",
			"Fallback test",
			undefined,
			undefined,
			details,
			false,
		);

		const calls = JSON.parse(readFileSync(stateFile, "utf8"));
		assert.deepEqual(calls.map((call) => call.model), ["provider/explicit", "caller/default"]);
		assert.deepEqual(calls.map((call) => call.thinking), ["high", "high"]);
		assert.equal(result.agentThinking, "high");
		assert.equal(calls[0].sessionId, calls[1].sessionId);
		assert.ok(calls[0].sessionId);
		assert.ok(calls.every((call) => call.orchestrated === "1" && call.legacy === undefined));
		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "caller/default");
		assert.match(result.warning, /retried with caller model caller\/default/);
	} finally {
		if (originalState === undefined) delete process.env.PI_SUBAGENT_TEST_STATE_FILE;
		else process.env.PI_SUBAGENT_TEST_STATE_FILE = originalState;
		if (originalLegacyMarker === undefined) delete process.env.PI_SUBPROCESS_CHILD;
		else process.env.PI_SUBPROCESS_CHILD = originalLegacyMarker;
		restorePi();
		rmSync(root, { recursive: true, force: true });
	}
});

test("runDelegation forwards definition thinking for new and resumed behavioral and locational children", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-thinking-"));
	const restorePi = useFakePi(root, join(root, "fake-pi.cjs"));
	const originalState = process.env.PI_SUBAGENT_TEST_STATE_FILE;
	const originalReuseEnabled = subagentSettings.reuseEnabled;
	const originalTrackedSessions = new Map(trackedSessions);
	try {
		trackedSessions.clear();
		subagentSettings.reuseEnabled = true;
		const stateFile = join(root, "state.json");
		writeFileSync(stateFile, "[]");
		const piPath = join(root, "fake-pi.cjs");
		writeFileSync(piPath, `
const fs = require("node:fs");
const calls = JSON.parse(fs.readFileSync(process.env.PI_SUBAGENT_TEST_STATE_FILE, "utf8"));
calls.push({ args: process.argv.slice(2) });
fs.writeFileSync(process.env.PI_SUBAGENT_TEST_STATE_FILE, JSON.stringify(calls));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }));
`);
		process.env.PI_SUBAGENT_TEST_STATE_FILE = stateFile;
		const ctx = delegationContext(root, []);
		const behavioral = { ...agent("behavioral"), id: "behavioral-thinking", rootDir: root, resumable: true, thinking: "high" };
		const locationalRoot = join(root, "locational-thinking");
		mkdirSync(locationalRoot);
		writeFileSync(join(locationalRoot, "SUBAGENTS.md"), "---\nthinking: low\n---\n");

		for (const [id, session] of [[behavioral.id, "new"], [behavioral.id, "resume"], [locationalRoot, "new"], [locationalRoot, "resume"]]) {
			const result = await runDelegation({ appendEntry: () => undefined }, ctx, root, [behavioral], id, session, "Thinking test", undefined, undefined, details, false);
			assert.equal(result.exitCode, 0);
		}
		const omitted = await runDelegation({ appendEntry: () => undefined }, ctx, root, [{ ...agent("behavioral"), id: "no-thinking", rootDir: root }], "no-thinking", "new", "No thinking test", undefined, undefined, details, false);
		assert.equal(omitted.exitCode, 0);

		const calls = JSON.parse(readFileSync(stateFile, "utf8"));
		const thinking = calls.map(({ args }) => {
			const index = args.indexOf("--thinking");
			return index < 0 ? undefined : args[index + 1];
		});
		assert.deepEqual(thinking, ["high", "high", "low", "low", undefined]);
		assert.ok(calls.every(({ args }) => args.slice(0, 3).join(" ") === "--mode json -p" && !args.includes("--rpc")));
		assert.ok(calls.slice(0, 4).every(({ args }) => args.includes("--session-id")));
		assert.ok(calls[4].args.includes("--no-session"));
	} finally {
		trackedSessions.clear();
		for (const [key, value] of originalTrackedSessions) trackedSessions.set(key, value);
		subagentSettings.reuseEnabled = originalReuseEnabled;
		if (originalState === undefined) delete process.env.PI_SUBAGENT_TEST_STATE_FILE;
		else process.env.PI_SUBAGENT_TEST_STATE_FILE = originalState;
		restorePi();
		rmSync(root, { recursive: true, force: true });
	}
});

test("runDelegation reports aborted foreground work", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-abort-"));
	const restorePi = useFakePi(root, join(root, "fake-pi.cjs"));
	try {
		const piPath = join(root, "fake-pi.cjs");
		writeFileSync(piPath, "setTimeout(() => {}, 10000);\n");
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 30);
		const result = await runDelegation(
			{ appendEntry: () => undefined },
			delegationContext(root, []),
			root,
			[{ ...agent("behavioral"), id: "test", rootDir: root }],
			"test",
			"new",
			"Abort test",
			controller.signal,
			undefined,
			details,
			false,
		);
		assert.equal(result.stopReason, "aborted");
		assert.match(result.errorMessage, /aborted/);
		assert.notEqual(result.exitCode, 0);
	} finally {
		restorePi();
		rmSync(root, { recursive: true, force: true });
	}
});
