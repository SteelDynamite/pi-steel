import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSubagentCall, renderSubagentResult } from "../render.ts";

const theme = {
	bold: (text) => text,
	fg: (_color, text) => text,
};

function result(overrides = {}) {
	return {
		agent: "scout",
		agentOrigin: "user",
		sessionIntent: "new",
		task: "Audit this session only: C:\\\\repo",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 211000, output: 4800, cacheRead: 1800000, cacheWrite: 0, cost: 0.0833, contextTokens: 200000, turns: 19 },
		model: "openai/gpt-5.6-luna",
		agentThinking: "high",
		...overrides,
	};
}

function rendered(value) {
	return value.render(240).map((line) => line.trimEnd()).join("\n");
}

function compact(agent, options = {}) {
	return rendered(renderSubagentResult({ content: [], details: { includeLocationalAgents: false, locationalAgents: [], results: [agent] } }, { expanded: false, ...options }, theme, { state: {} }));
}

test("call labels only selected definition overrides", () => {
	for (const origin of ["bundled", "user", "project", "locational"]) {
		const context = { state: {} };
		const call = renderSubagentCall({ id: "scout", session: "new", task: "Audit" }, theme, context);
		renderSubagentResult({ content: [], details: { results: [result({ agentOrigin: origin, agentOverride: false })] } }, { expanded: false, isPartial: true }, theme, context);
		const text = rendered(call);
		assert.doesNotMatch(text, /override|bundled|user|project|locational/);
		assert.match(text, /^subagent scout \[session:new\]/);
	}
	const context = { state: {} };
	const call = renderSubagentCall({ id: "scout", session: "new", task: "Audit" }, theme, context);
	renderSubagentResult({ content: [], details: { results: [result({ agentOverride: true })] } }, { expanded: false, isPartial: true }, theme, context);
	assert.match(rendered(call), /^subagent scout \(override\) \[session:new\]/);
});

test("compact running result is agent-free and shows declared thinking", () => {
	const text = compact(result(), { isPartial: true });
	assert.match(text, /^⏳ running · openai\/gpt-5\.6-luna · high$/m);
	assert.match(text, /19 turns ↑211k ↓4\.8k R1\.8M \$0\.0833 ctx:200k/);
	assert.doesNotMatch(text, /scout|session:new|\(no output\)/);
});

test("compact result shows default thinking without inferring it", () => {
	const text = compact(result({ exitCode: 0, agentThinking: undefined, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } }));
	assert.match(text, /^✓ completed · openai\/gpt-5\.6-luna · default$/m);
	assert.match(text, /\(no output\)/);
});

test("completed and failed compact results preserve useful output", () => {
	const complete = compact(result({ exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Audit complete" }] }] }));
	assert.match(complete, /✓ completed · openai\/gpt-5\.6-luna · high/);
	assert.match(complete, /Audit complete/);
	const failed = compact(result({ exitCode: 1, stopReason: "context_limit", errorMessage: "Subagent hit context limit." }));
	assert.match(failed, /✗ context_limit · openai\/gpt-5\.6-luna · high/);
	assert.match(failed, /Error: Subagent hit context limit\./);
});

test("requested speed in live, historical, and nested views comes only from stored metadata", () => {
	const previousSpeed = process.env.PI_CHATGPT_SPEED;
	const previousFast = process.env.PI_CHATGPT_FAST;
	try {
		for (const speed of ["standard", "fast", "ultrafast"]) {
			process.env.PI_CHATGPT_SPEED = speed;
			process.env.PI_CHATGPT_FAST = "1";
			for (const expanded of [false, true]) {
				for (const exitCode of [-1, 0, 1]) {
					const saved = JSON.parse(JSON.stringify(result({ model: "openai/gpt-6-astra", exitCode, requestedSpeed: "ultrafast" })));
					const text = compact(saved, { expanded, isPartial: exitCode === -1 });
					assert.match(text, / · high · Ultrafast requested$/m);
					assert.doesNotMatch(text, /confirmed|accepted|standard requested|Fast requested/);
					delete saved.requestedSpeed;
					assert.doesNotMatch(compact(saved, { expanded, isPartial: exitCode === -1 }), /requested|fast|standard/i);
				}
				const nested = result({ nestedSubagents: [{
					toolCallId: "nested", toolName: "subagent", status: "running",
					details: { results: [result({ agent: "requested-child", requestedSpeed: "ultrafast" }), result({ agent: "old-child" })] },
				}] });
				const nestedText = compact(JSON.parse(JSON.stringify(nested)), { expanded, isPartial: true });
				assert.match(nestedText, /requested-child · Ultrafast requested/);
				assert.doesNotMatch(nestedText, /old-child · Ultrafast/);
				assert.equal(nestedText.match(/Ultrafast requested/g)?.length, 1);
			}
		}
	} finally {
		if (previousSpeed === undefined) delete process.env.PI_CHATGPT_SPEED;
		else process.env.PI_CHATGPT_SPEED = previousSpeed;
		if (previousFast === undefined) delete process.env.PI_CHATGPT_FAST;
		else process.env.PI_CHATGPT_FAST = previousFast;
	}
});

test("token speed is card-local, approximate live, and stable in compact/expanded historical and nested cards", () => {
	const originalNow = Date.now;
	try {
		for (const expanded of [false, true]) {
			const live = { mode: "live", tokens: 20, durationMs: 1000 };
			const aggregate = { mode: "aggregate", tokens: 75, durationMs: 3000 };
			const agent = result({ requestedSpeed: "ultrafast", tokenSpeed: live });
			assert.match(compact(agent, { expanded, isPartial: true }), /Ultrafast requested · ~20\.0 tok\/s/);
			for (const exitCode of [0, 1]) {
				const historical = JSON.parse(JSON.stringify({ ...agent, exitCode, tokenSpeed: aggregate }));
				const before = compact(historical, { expanded });
				Date.now = () => 99999999999999;
				assert.equal(compact(historical, { expanded }), before);
				assert.match(before, /Ultrafast requested · 25\.0 tok\/s/);
				assert.doesNotMatch(before, /~25/);
			}
			const nested = result({ tokenSpeed: aggregate, nestedSubagents: [
				{ toolCallId: "a", toolName: "subagent", status: "running", details: { results: [result({ agent: "live-child", tokenSpeed: live })] } },
				{ toolCallId: "b", toolName: "subagent", status: "completed", details: { results: [result({ agent: "done-child", exitCode: 0, tokenSpeed: aggregate })] } },
			] });
			const text = compact(JSON.parse(JSON.stringify(nested)), { expanded, isPartial: true });
			assert.match(text, /live-child · ~20\.0 tok\/s/);
			assert.match(text, /done-child · 25\.0 tok\/s/);
			for (const tokenSpeed of [undefined, null, {}, { mode: "aggregate", tokens: "20", durationMs: 1000 }, { mode: "live", tokens: 20, durationMs: 0 }]) {
				assert.doesNotMatch(compact(result({ tokenSpeed }), { expanded }), /tok\/s/);
			}
		}
	} finally {
		Date.now = originalNow;
	}
});

test("expanded running result omits an empty output placeholder", () => {
	const view = renderSubagentResult({ content: [], details: { results: [result()] } }, { expanded: true, isPartial: true }, theme, { state: {} });
	assert.doesNotMatch(rendered(view), /─── Output ───|\(no output\)/);
});
