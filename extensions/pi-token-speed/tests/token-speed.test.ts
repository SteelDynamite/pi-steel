import assert from "node:assert/strict";
import test from "node:test";
import extension from "../index.ts";
import { formatSpeed, streamDelta, TokenSpeedTracker } from "../src/token-speed.ts";

const closeTo = (actual: number | undefined, expected: number) => {
	assert.ok(actual !== undefined);
	assert.ok(Math.abs(actual - expected) < 0.000_001, `${actual} !== ${expected}`);
};

test("live estimate warms up, omits the first chunk, and uses a five-second window", () => {
	const tracker = new TokenSpeedTracker();
	tracker.beginCall();
	assert.equal(tracker.addDelta("a".repeat(40), 0), undefined);
	assert.equal(tracker.addDelta("a".repeat(20), 499), undefined);
	closeTo(tracker.addDelta("a".repeat(20), 500), 20);
	closeTo(tracker.addDelta("a".repeat(20), 6_000), 1);
});

test("final provider usage excludes the first output token", () => {
	const tracker = new TokenSpeedTracker();
	tracker.beginCall();
	tracker.addDelta("first", 0);
	tracker.addDelta("later", 1_000);
	closeTo(tracker.endCall(10), 9);
});

test("final aggregate weights provider-exact tokens by inter-output duration", () => {
	const tracker = new TokenSpeedTracker();
	tracker.beginCall();
	tracker.addDelta("first", 0);
	tracker.addDelta("later", 1_000);
	closeTo(tracker.endCall(41), 40);

	tracker.beginCall();
	tracker.addDelta("first", 2_000);
	tracker.addDelta("later", 4_000);
	closeTo(tracker.endCall(21), 20);
});

test("final reconciliation uses the last emitted delta, not completion time", () => {
	const tracker = new TokenSpeedTracker();
	tracker.beginCall();
	tracker.addDelta("first", 0);
	tracker.addDelta("later", 1_000);
	closeTo(tracker.endCall(11), 10);
});

test("fallback excludes the first chunk and survives live-window pruning", () => {
	const tracker = new TokenSpeedTracker();
	tracker.beginCall();
	tracker.addDelta("a".repeat(40), 0);
	tracker.addDelta("a".repeat(20), 500);
	closeTo(tracker.addDelta("a".repeat(20), 6_000), 1);
	closeTo(tracker.endCall(undefined), 10 / 6);
});

test("zero provider usage uses post-first-output fallback", () => {
	const tracker = new TokenSpeedTracker();
	tracker.beginCall();
	tracker.addDelta("a".repeat(20), 0);
	tracker.addDelta("a".repeat(20), 1_000);
	closeTo(tracker.endCall(0), 5);
});

test("one-chunk and zero-duration calls do not skew the aggregate", () => {
	const tracker = new TokenSpeedTracker();
	tracker.beginCall();
	tracker.addDelta("first", 0);
	tracker.addDelta("later", 1_000);
	closeTo(tracker.endCall(11), 10);

	tracker.beginCall();
	tracker.addDelta("only", 2_000);
	closeTo(tracker.endCall(100), 10);

	tracker.beginCall();
	tracker.addDelta("first", 3_000);
	tracker.addDelta("later", 3_000);
	closeTo(tracker.endCall(100), 10);
});

test("deltas include text, thinking, and tool calls only", () => {
	assert.equal(streamDelta({ type: "text_delta", delta: "text" }), "text");
	assert.equal(streamDelta({ type: "thinking_delta", delta: "thought" }), "thought");
	assert.equal(streamDelta({ type: "toolcall_delta", delta: "{}" }), "{}");
	assert.equal(streamDelta({ type: "done" }), undefined);
	assert.equal(formatSpeed(25), "25.0 tok/s");
});

for (const mode of ["tui", "rpc", "print", "json"] as const) test(`extension status respects ${mode} mode and clears on a new agent run`, () => {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => void) {
			handlers.set(name, handler);
		},
	} as any;
	extension(pi);

	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const hasUI = mode === "tui" || mode === "rpc";
	const ctx = {
		mode,
		hasUI,
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			get theme() {
				assert.equal(mode, "tui", "headless modes must not access the terminal theme");
				return { fg: (color: string, text: string) => `${color}:${text}` };
			},
		},
	};
	const originalNow = Date.now;
	let now = 0;
	Date.now = () => now;
	try {
		handlers.get("agent_start")!({}, ctx);
		handlers.get("message_update")!({ assistantMessageEvent: { type: "start" } }, ctx);
		handlers.get("message_update")!({ assistantMessageEvent: { type: "text_delta", delta: "a".repeat(20) } }, ctx);
		now = 1_000;
		handlers.get("message_update")!({ assistantMessageEvent: { type: "text_delta", delta: "a".repeat(20) } }, ctx);
		assert.deepEqual(statuses, hasUI ? [
			{ key: "tokenSpeed", text: undefined },
			{ key: "tokenSpeed", text: undefined },
			{ key: "tokenSpeed", text: mode === "tui" ? "dim:5.0 tok/s" : "5.0 tok/s" },
		] : []);
		now = 10_000;
		handlers.get("message_end")!({ message: { role: "assistant", usage: { output: 20 }, stopReason: "error" } }, ctx);
		assert.deepEqual(statuses.at(-1), hasUI
			? { key: "tokenSpeed", text: mode === "tui" ? "dim:19.0 tok/s" : "19.0 tok/s" }
			: undefined);

		handlers.get("agent_start")!({}, ctx);
		assert.deepEqual(statuses.at(-1), hasUI ? { key: "tokenSpeed", text: undefined } : undefined);
		if (!hasUI) assert.deepEqual(statuses, []);
	} finally {
		Date.now = originalNow;
	}
});
