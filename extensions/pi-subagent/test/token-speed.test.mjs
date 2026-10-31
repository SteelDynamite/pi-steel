import assert from "node:assert/strict";
import { test } from "node:test";
import { processChildJsonEvent } from "../execution.ts";
import { makeErrorResult } from "../result.ts";
import { formatTokenSpeed, streamDelta, TokenSpeedTracker } from "../token-speed.ts";
import { speedFixtures } from "./fixtures/token-speed.mjs";

const rate = (measurement) => measurement && measurement.tokens / (measurement.durationMs / 1000);
for (const fixture of speedFixtures) {
	test(`footer parity: ${fixture.name}`, () => {
		const tracker = new TokenSpeedTracker();
		for (const [method, args, expected] of fixture.steps) {
			assert.equal(rate(tracker[method](...args)), expected, `${method}(${args})`);
		}
	});
}

const usage = (output = 0) => ({ input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output, cost: { total: 0 } });
const start = { type: "message_start", message: { role: "assistant", content: [], timestamp: 99999999999 } };
const delta = (text, type = "text_delta") => ({ type: "message_update", usage: usage(), assistantMessageEvent: { type, contentIndex: 0, delta: text } });
const end = (output = 0) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "not counted twice" }], usage: usage(output) } });

function harness() {
	let now = 0;
	const result = { ...makeErrorResult("test", "task", ""), exitCode: -1 };
	const progress = { speed: new TokenSpeedTracker(), now: () => now };
	const updates = [];
	return {
		result, updates, progress,
		send(event, at = now) {
			now = at;
			processChildJsonEvent(event, result, () => updates.push({ at: now, details: structuredClone(result) }), progress);
		},
	};
}

test("delta-only JSON events count text/thinking/tool arguments once, not usage or snapshots", () => {
	const h = harness();
	h.send(start, 10000); // Arbitrary message timestamp and TTFT are irrelevant.
	h.send(delta("discard the whole first chunk", "thinking_delta"), 20000);
	h.send(delta("abcd", "thinking_delta"), 20500);
	h.send(delta("abcd"), 20750);
	const tool = delta("abcdefgh", "toolcall_delta");
	// Older SDK snapshot-shaped updates are also safe: only delta is counted.
	tool.message = { role: "assistant", content: [{ type: "text", text: "x".repeat(10000) }] };
	tool.assistantMessageEvent.partial = tool.message;
	tool.usage = usage(10000);
	h.send(tool, 21000);
	assert.deepEqual(h.result.tokenSpeed, { mode: "live", tokens: 4, durationMs: 1000 });
	for (const type of ["text_start", "text_end", "thinking_end", "toolcall_end", "done"]) {
		h.send({ type: "message_update", assistantMessageEvent: { type, content: "x".repeat(10000), delta: "ignored" } }, 22000);
	}
	assert.equal(h.result.messages.length, 0);
	h.send(end(), 90000); // Completion tail excluded; fallback doesn't count message content.
	assert.deepEqual(h.result.tokenSpeed, { mode: "aggregate", tokens: 4, durationMs: 1000 });
	assert.equal(h.result.messages.length, 1);
	assert.equal(h.result.usage.turns, 1);
});

test("no deltas means no label; tool waiting holds aggregate and new call warms up independently", () => {
	const h = harness();
	h.send(start);
	h.send(end(400), 10000);
	assert.equal(h.result.tokenSpeed, undefined);
	h.send(start);
	h.send(delta("first"), 20000);
	h.send(delta("abcd"), 21000);
	h.send(end(21), 22000);
	const completed = structuredClone(h.result.tokenSpeed);
	h.send({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: {} }, 30000);
	h.send({ type: "message_end", message: { role: "toolResult", content: [], usage: usage(1000000) } }, 50000);
	h.send({ type: "agent_start" }, 51000); // Internal retries aren't new delegations.
	assert.deepEqual(h.result.tokenSpeed, completed);
	h.send(start, 52000);
	h.send(delta("first"), 60000);
	assert.equal(h.result.tokenSpeed, undefined);
	h.send(delta("abcd"), 62000);
	h.send(end(11), 80000);
	assert.deepEqual(h.result.tokenSpeed, { mode: "aggregate", tokens: 30, durationMs: 3000 });
});

test("speed progress is event-driven and throttled to 250ms; message completion is immediate", () => {
	const h = harness();
	h.send(start);
	h.send(delta("first"));
	for (let at = 10; at <= 1000; at += 10) h.send(delta("abcd"), at);
	assert.deepEqual(h.updates.map(({ at }) => at), [500, 750, 1000]);
	assert.equal(h.result.tokenSpeed.tokens, 100); // Throttling must not drop samples.
	h.send(end(101), 1001);
	assert.equal(h.updates.at(-1).at, 1001);
	assert.deepEqual(h.updates.at(-1).details.tokenSpeed, { mode: "aggregate", tokens: 100, durationMs: 1000 });
});

test("interleaved children and nested details retain independent speed, never aggregate descendants", () => {
	const a = harness();
	const b = harness();
	for (const h of [a, b]) h.send(delta("first"));
	a.send(delta("abcd"), 1000);
	b.send(delta("x".repeat(80)), 1000);
	a.send(end(11));
	b.send(end(101));
	a.send({ type: "tool_execution_update", toolCallId: "nested", toolName: "subagent", partialResult: { details: { results: [b.result] } } });
	assert.equal(rate(a.result.tokenSpeed), 10);
	assert.equal(rate(a.result.nestedSubagents[0].details.results[0].tokenSpeed), 100);
	assert.equal(a.result.usage.output, 11);
	assert.equal(a.updates.at(-1).details.nestedSubagents[0].toolCallId, "nested");
});

test("stream selector and measurement formatting reject malformed data", () => {
	for (const value of [undefined, null, {}, { type: "text_delta", delta: 3 }, { type: "text_end", delta: "abcd" }]) assert.equal(streamDelta(value), undefined);
	for (const value of [undefined, null, {}, 4, { mode: "live", tokens: 1 }, { mode: "other", tokens: 1, durationMs: 1 }]) assert.equal(formatTokenSpeed(value), "");
	for (const field of ["tokens", "durationMs"]) {
		for (const invalid of [undefined, null, "5", NaN, Infinity, -1, 0]) {
			assert.equal(formatTokenSpeed({ mode: "aggregate", tokens: 10, durationMs: 1000, [field]: invalid }), "");
		}
	}
	assert.equal(formatTokenSpeed({ mode: "live", tokens: 10, durationMs: 1000 }), " · ~10.0 tok/s");
	assert.equal(formatTokenSpeed({ mode: "aggregate", tokens: 10, durationMs: 1000 }), " · 10.0 tok/s");
	assert.equal(formatTokenSpeed({ mode: "live", tokens: Number.MAX_VALUE, durationMs: Number.MIN_VALUE }), "");
});
