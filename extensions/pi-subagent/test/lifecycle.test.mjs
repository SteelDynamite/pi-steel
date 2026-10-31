import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createAgentLifecycle,
	markAgentActivity,
	markAgentClosed,
	markAgentTerminating,
	recordAgentError,
} from "../lifecycle.ts";

test("agent lifecycle tracks activity, abort, and close", () => {
	const state = createAgentLifecycle("worker", 10);
	assert.equal(state.phase, "starting");
	markAgentActivity(state, 20);
	assert.equal(state.phase, "running");
	assert.equal(markAgentTerminating(state, 30), true);
	assert.equal(markAgentTerminating(state, 35), false);
	assert.equal(state.stopReason, "aborted");
	assert.match(state.errorMessage, /aborted/);
	markAgentClosed(state, 130, 40);
	assert.equal(state.phase, "closed");
	assert.equal(state.exitCode, 130);
	assert.equal(state.terminatedAt, 40);
});

test("agent lifecycle records spawn errors", () => {
	const state = createAgentLifecycle("worker", 1);
	recordAgentError(state, "boom", 2);
	markAgentClosed(state, 1, 3);
	assert.equal(state.stopReason, "error");
	assert.equal(state.errorMessage, "boom");
	assert.equal(state.exitCode, 1);
});
