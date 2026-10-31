import assert from "node:assert/strict";
import { test } from "node:test";
import { processChildJsonEvent } from "../execution.ts";
import { applyNestedSubagentEvent } from "../nested.ts";
import { formatNestedSubagentsForDisplay } from "../render.ts";

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });

function result(overrides = {}) {
	return {
		agent: "owner",
		agentOrigin: "user",
		task: "owning task",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: usage(),
		...overrides,
	};
}

function details(results) {
	return { includeLocationalAgents: false, locationalAgents: [], results };
}

function assistantText(text) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

test("processChildJsonEvent tracks nested subagent calls by toolCallId", () => {
	const owner = result();
	let updates = 0;
	const emitUpdate = () => updates++;
	processChildJsonEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "subagent", args: {} }, owner, emitUpdate);
	assert.equal(owner.nestedSubagents[0].status, "running");
	processChildJsonEvent({
		type: "tool_execution_update",
		toolCallId: "call-1",
		toolName: "subagent",
		partialResult: { details: details([result({ agent: "nested-a", exitCode: -1 })]) },
	}, owner, emitUpdate);
	assert.equal(owner.nestedSubagents[0].details.results[0].agent, "nested-a");
	processChildJsonEvent({
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "subagent",
		result: { details: details([result({ agent: "nested-a", messages: [assistantText("done")] })]) },
		isError: false,
	}, owner, emitUpdate);
	assert.equal(owner.nestedSubagents[0].status, "completed");
	assert.equal(owner.nestedSubagents[0].details.results[0].messages[0].content[0].text, "done");
	assert.equal(updates, 3);
});

test("interleaved nested updates stay separated", () => {
	const owner = result();
	for (const id of ["a", "b"]) processChildJsonEvent({ type: "tool_execution_start", toolCallId: id, toolName: "subagent", args: {} }, owner, () => {});
	processChildJsonEvent({ type: "tool_execution_update", toolCallId: "b", toolName: "subagent", partialResult: { details: details([result({ agent: "beta" })]) } }, owner, () => {});
	processChildJsonEvent({ type: "tool_execution_update", toolCallId: "a", toolName: "subagent", partialResult: { details: details([result({ agent: "alpha" })]) } }, owner, () => {});
	assert.equal(owner.nestedSubagents.find((call) => call.toolCallId === "a").details.results[0].agent, "alpha");
	assert.equal(owner.nestedSubagents.find((call) => call.toolCallId === "b").details.results[0].agent, "beta");
});

test("unrelated and legacy tool events are ignored", () => {
	const owner = result();
	assert.equal(applyNestedSubagentEvent(owner, { type: "tool_execution_start", toolCallId: "read-1", toolName: "read" }), false);
	assert.equal(applyNestedSubagentEvent(owner, { type: "tool_execution_start", toolCallId: "plural-1", toolName: "subagents" }), false);
	assert.equal(applyNestedSubagentEvent(owner, { type: "tool_execution_start", toolCallId: "old-1", toolName: "subprocess" }), false);
	assert.equal(owner.nestedSubagents, undefined);
});

test("large nested details are conservatively capped", () => {
	const owner = result();
	const huge = "x".repeat(40_000);
	applyNestedSubagentEvent(owner, {
		type: "tool_execution_update",
		toolCallId: "large",
		toolName: "subagent",
		partialResult: { details: details([result({ agent: "large", requestedSpeed: "ultrafast", tokenSpeed: { mode: "aggregate", tokens: 40, durationMs: 2000 }, task: huge, messages: [assistantText(huge)] })]) },
	});
	const nested = owner.nestedSubagents[0];
	assert.equal(nested.truncated, true);
	assert.equal(nested.details.results[0].messages.length, 0);
	assert.equal(nested.details.results[0].requestedSpeed, "ultrafast");
	assert.deepEqual(nested.details.results[0].tokenSpeed, { mode: "aggregate", tokens: 40, durationMs: 2000 });
	assert.match(formatNestedSubagentsForDisplay([nested]), /20\.0 tok\/s/);
	assert.match(nested.details.results[0].task, /\[truncated\]/);
});

test("nested formatter renders recursive indented details", () => {
	const nested = [{
		toolCallId: "outer-call",
		toolName: "subagent",
		status: "completed",
		details: details([result({
			agent: "outer-nested",
			messages: [assistantText("outer done")],
			nestedSubagents: [{
				toolCallId: "inner-call",
				toolName: "subagent",
				status: "running",
				details: details([result({ agent: "inner", exitCode: -1 })]),
			}],
		})]),
	}];
	const text = formatNestedSubagentsForDisplay(nested);
	assert.match(text, /subagent/);
	assert.match(text, /outer-nested/);
	assert.match(text, /inner/);
	assert.match(text, /↳/);
});
