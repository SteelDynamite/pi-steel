import assert from "node:assert/strict";
import { useFakePi } from "./fixtures/pi-host.mjs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDelegation } from "../execution.ts";
import { subagentSettings, trackedSessions } from "../state.ts";

const astra = { provider: "openai", id: "gpt-6-astra", contextWindow: 4000 };
const sol = { provider: "openai", id: "gpt-6.1-sol", contextWindow: 4000 };
const ref = (model) => model ? `${model.provider}/${model.id}` : undefined;
const details = (results) => ({ includeLocationalAgents: false, locationalAgents: [], results });
const definition = (root, model) => ({ id: "speed-test", kind: "behavioral", origin: "user", rootDir: root, filePath: join(root, "SUBAGENTS.md"), model, manifest: true, description: "", systemPrompt: "", resumable: false });
const context = (root, model, models, oauth = true) => ({
	cwd: root, model, isProjectTrusted: () => true, sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
	modelRegistry: { getAvailable: () => models, isUsingOAuth: (child) => { assert.ok(child === model || models.includes(child)); return oauth; } },
});

async function withChild(run) {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-requested-speed-"));
	const restorePi = useFakePi(root, join(root, "fake-pi.cjs"));
	const originalEnv = new Map(["PI_CHATGPT_SPEED", "PI_CHATGPT_FAST", "PI_SUBAGENT_TEST_STATE_FILE", "PI_SUBAGENT_DEPTH"].map((key) => [key, process.env[key]]));
	try {
		const stateFile = join(root, "calls.json");
		writeFileSync(stateFile, "[]");
		const executable = join(root, "fake-pi.cjs");
		writeFileSync(executable, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined;
const calls = JSON.parse(fs.readFileSync(process.env.PI_SUBAGENT_TEST_STATE_FILE, "utf8"));
calls.push({ model, speed: process.env.PI_CHATGPT_SPEED, fast: process.env.PI_CHATGPT_FAST });
fs.writeFileSync(process.env.PI_SUBAGENT_TEST_STATE_FILE, JSON.stringify(calls));
const failed = args.at(-1) === "Task: fail:" + model;
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model, content: failed ? [] : [{ type: "text", text: "first" }], ...(failed ? { stopReason: "error", errorMessage: "provider unavailable" } : {}) } }));
if (failed) process.exit(1);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model, content: [{ type: "text", text: "done" }] } }));
`);
		process.env.PI_SUBAGENT_TEST_STATE_FILE = stateFile;
		process.env.PI_SUBAGENT_DEPTH = "0";
		await run(root, () => JSON.parse(readFileSync(stateFile, "utf8")));
	} finally {
		restorePi();
		for (const [key, value] of originalEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

test("Ultrafast requested snapshots final child env and child model/auth, never parent FAST", async () => {
	await withChild(async (root, calls) => {
		const cases = [
			{ speed: "ultrafast", fast: "0", child: astra, expected: "ultrafast" },
			{ speed: "ULTRAFAST", fast: "1", child: astra, expected: "ultrafast" },
			{ speed: "ultrafast", child: { ...astra, provider: "OPENAI" } },
			{ speed: "ultrafast", child: astra, oauth: false },
			{ speed: "ultrafast", child: astra, missingAuthCheck: true },
			{ speed: "ultrafast", fast: "0", child: sol, expected: "ultrafast" },
			{ speed: "ULTRAFAST", fast: "1", child: sol, expected: "ultrafast" },
			{ speed: "ultrafast", child: { ...sol, provider: "OPENAI" } },
			{ speed: "ultrafast", child: sol, oauth: false },
			{ speed: "ultrafast", child: sol, missingAuthCheck: true },
			{ speed: "ultrafast", child: { ...sol, provider: "other" } },
			{ speed: "ultrafast", child: { ...sol, provider: "openai-work" } },
			{ speed: "ultrafast", child: { ...sol, id: "gpt-6-luna" } },
			{ speed: "ultrafast", child: { ...sol, id: "GPT-6.1-SOL" } },
			{ speed: "ultrafast", child: { ...sol, id: "gpt-6.1-sol-extra" } },
			{ speed: " ultrafast", child: sol },
			{ speed: "ultrafast ", child: sol },
			{ speed: "standard", fast: "1", child: sol },
			{ speed: "fast", fast: "1", child: sol },
			{ fast: "1", child: sol },
			{ speed: "ultrafast", child: { ...astra, id: "GPT-6-ASTRA" } },
			{ speed: "ultrafast", child: { ...astra, provider: "other" } },
			{ speed: "ultrafast", child: { ...astra, provider: "openai-work" } },
			{ speed: "ultrafast", child: { ...astra, provider: "openai-1" } },
			{ speed: " ultrafast", fast: "1", child: astra },
			{ speed: "ultrafast ", fast: "1", child: astra },
			{ speed: "standard", fast: "1", child: astra },
			{ speed: "fast", fast: "1", child: astra },
			{ speed: "unknown", fast: "1", child: astra },
			{ fast: "1", child: astra },
			{ fast: "0", child: astra },
			{ speed: "ultrafast", child: undefined },
		];
		for (const item of cases) {
			for (const [key, value] of [["PI_CHATGPT_SPEED", item.speed], ["PI_CHATGPT_FAST", item.fast]]) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			// Parent FAST never establishes child eligibility.
			const ctx = context(root, item.child ? sol : undefined, item.child ? [item.child] : [], item.oauth ?? true);
			if (item.missingAuthCheck) delete ctx.modelRegistry.isUsingOAuth;
			else ctx.modelRegistry.isUsingOAuth = (child) => { assert.equal(child, item.child); return item.oauth ?? true; };
			const agent = definition(root, ref(item.child));
			const updates = [];
			const result = await runDelegation({ appendEntry() {} }, ctx, root, [agent], agent.id, "new", "work", undefined, (update) => {
				updates.push(JSON.parse(JSON.stringify(update.details)));
				// Rendering/completion must not consult the now-different parent's environment.
				process.env.PI_CHATGPT_SPEED = "standard";
				process.env.PI_CHATGPT_FAST = "1";
			}, details, false);
			assert.equal(result.exitCode, 0);
			assert.equal(result.requestedSpeed, item.expected, JSON.stringify(item));
			assert.equal("requestedSpeed" in result, item.expected !== undefined);
			assert.equal(updates.length, 2);
			assert.ok(updates.every((update) => update.results[0].requestedSpeed === item.expected));
			assert.deepEqual(calls().at(-1), { ...(item.child ? { model: ref(item.child) } : {}), ...(item.speed === undefined ? {} : { speed: item.speed }), ...(item.fast === undefined ? {} : { fast: item.fast }) });
		}

		// Same-caller selection need not be present in getAvailable().
		process.env.PI_CHATGPT_SPEED = "ultrafast";
		process.env.PI_CHATGPT_FAST = "0";
		const sameCaller = definition(root);
		for (const model of [astra, sol]) {
			const same = await runDelegation({ appendEntry() {} }, context(root, model, []), root, [sameCaller], sameCaller.id, "new", "work", undefined, undefined, details, false);
			assert.equal(same.requestedSpeed, "ultrafast");
		}

		// Prompt preparation yields before spawn: snapshot the final env, not delegation entry.
		sameCaller.systemPrompt = "Test prompt";
		const preparing = runDelegation({ appendEntry() {} }, context(root, astra, []), root, [sameCaller], sameCaller.id, "new", "work", undefined, undefined, details, false);
		process.env.PI_CHATGPT_SPEED = "standard";
		assert.equal((await preparing).requestedSpeed, undefined);
		assert.equal(calls().at(-1).speed, "standard");
	});
});

test("resumed launches capture new requested intent without relabeling prior details", async () => {
	const originalReuse = subagentSettings.reuseEnabled;
	const originalTracked = new Map(trackedSessions);
	try {
		subagentSettings.reuseEnabled = true;
		trackedSessions.clear();
		await withChild(async (root) => {
			const agent = { ...definition(root), resumable: true };
			const ctx = context(root, sol, []);
			const results = [];
			for (const [session, speed] of [["new", "ultrafast"], ["resume", "standard"], ["resume", "ultrafast"]]) {
				process.env.PI_CHATGPT_SPEED = speed;
				const result = await runDelegation({ appendEntry() {} }, ctx, root, [agent], agent.id, session, "work", undefined, undefined, details, false);
				assert.equal(result.exitCode, 0);
				assert.equal(result.nextSessionIntent, "resume");
				results.push(JSON.parse(JSON.stringify(details([result]))));
			}
			assert.deepEqual(results.map((value) => value.results[0].requestedSpeed), ["ultrafast", undefined, "ultrafast"]);
		});
	} finally {
		subagentSettings.reuseEnabled = originalReuse;
		trackedSessions.clear();
		for (const [key, value] of originalTracked) trackedSessions.set(key, value);
	}
});

test("Ultrafast intent is recomputed for each actual locational retry launch", async () => {
	await withChild(async (root, calls) => {
		const location = join(root, "owner");
		mkdirSync(location);
		for (const [selected, parent, changeEnv, expected] of [
			[sol, astra, false, ["ultrafast", "ultrafast"]],
			[astra, sol, false, ["ultrafast", "ultrafast"]],
			[{ ...sol, id: "gpt-6-luna" }, sol, false, [undefined, "ultrafast"]],
			[sol, { ...sol, id: "gpt-6-luna" }, false, ["ultrafast", undefined]],
			[sol, astra, true, ["ultrafast", undefined]],
		]) {
			writeFileSync(join(location, "SUBAGENTS.md"), `---\nmodel: ${ref(selected)}\nresumable: false\n---\n`);
			process.env.PI_CHATGPT_SPEED = "ultrafast";
			process.env.PI_CHATGPT_FAST = "0";
			const updates = [];
			const count = calls().length;
			const result = await runDelegation({ appendEntry() {} }, context(root, parent, [selected]), root, [], location, "new", `fail:${ref(selected)}`, undefined, (update) => {
				updates.push(JSON.parse(JSON.stringify(update.details.results[0])));
				if (changeEnv) process.env.PI_CHATGPT_SPEED = "standard";
			}, details, false);
			assert.equal(result.exitCode, 0);
			assert.match(result.warning, /retried with caller model/);
			assert.equal(result.requestedSpeed, expected[1]);
			assert.deepEqual(updates.map((update) => update.requestedSpeed), [expected[0], expected[1], expected[1]]);
			assert.deepEqual(calls().slice(count).map(({ model, speed }) => [model, speed]), [[ref(selected), "ultrafast"], [ref(parent), changeEnv ? "standard" : "ultrafast"]]);
		}
	});
});
