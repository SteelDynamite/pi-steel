import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
	getNestedSubagentIds,
	getResultOutput,
	isFailedResult,
} from "../result.ts";

const assistant = (content, extra = {}) => ({ role: "assistant", content, ...extra });

test("getFinalOutput returns the last non-empty assistant text", () => {
	const messages = [
		assistant([{ type: "text", text: "real answer" }]),
		{ role: "custom", content: "<system-reminder />" },
		assistant([{ type: "text", text: "  \n\t" }]),
	];
	assert.equal(getFinalOutput(messages), "real answer");
});

test("isFailedResult treats nonzero exit and terminal error reasons as failures", () => {
	assert.equal(isFailedResult({ exitCode: 1, stopReason: "end" }), true);
	assert.equal(isFailedResult({ exitCode: 0, stopReason: "error" }), true);
	assert.equal(isFailedResult({ exitCode: 0, stopReason: "aborted" }), true);
	assert.equal(isFailedResult({ exitCode: 0, stopReason: "context_limit" }), true);
	assert.equal(isFailedResult({ exitCode: 0, stopReason: "end" }), false);
});

test("getResultOutput includes warnings, final output, next intent, and errors", () => {
	assert.equal(getResultOutput({
		exitCode: 0,
		warning: "careful",
		nextSessionIntent: "resume",
		messages: [assistant([{ type: "text", text: "done" }])],
	}), 'Warning: careful\n\ndone\n\nNext call to this subagent should use session: "resume"');
	assert.equal(getResultOutput({ exitCode: 1, errorMessage: "boom", stderr: "stderr", messages: [] }), "boom");
});

test("display helpers recognize only singular subagent calls", () => {
	const messages = [assistant([
		{ type: "text", text: "thinking" },
		{ type: "toolCall", name: "subagent", arguments: { id: "a", session: "new", task: "work" } },
		{ type: "toolCall", name: "subprocess", arguments: { id: "legacy" } },
		{ type: "toolCall", name: "read", arguments: { path: "x" } },
	])];
	assert.deepEqual(getDisplayItems(messages), [
		{ type: "text", text: "thinking" },
		{ type: "toolCall", name: "subagent", args: { id: "a", session: "new", task: "work" } },
		{ type: "toolCall", name: "subprocess", args: { id: "legacy" } },
		{ type: "toolCall", name: "read", args: { path: "x" } },
	]);
	assert.deepEqual(getNestedSubagentIds(messages), ["a"]);
});

test("formatUsageStats does not infer child speed from parent environment", () => {
	const previous = process.env.PI_CHATGPT_FAST;
	const usage = { input: 1200, output: 25, cacheRead: 0, cacheWrite: 2000, cost: 0.01234, contextTokens: 5000, turns: 2 };
	try {
		process.env.PI_CHATGPT_FAST = "0";
		assert.equal(formatUsageStats(usage, "provider/model"), "2 turns ↑1.2k ↓25 W2.0k $0.0123 ctx:5.0k provider/model");
		process.env.PI_CHATGPT_FAST = "1";
		assert.equal(formatUsageStats(usage, "provider/model"), "2 turns ↑1.2k ↓25 W2.0k $0.0123 ctx:5.0k provider/model");
	} finally {
		if (previous === undefined) delete process.env.PI_CHATGPT_FAST;
		else process.env.PI_CHATGPT_FAST = previous;
	}
});
