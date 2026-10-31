import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SUBAGENT_STATE_ENTRY } from "../constants.ts";
import {
	formatWrongIntentReason,
	getRequiredSessionIntent,
	restoreSubagentState,
	subagentSettings,
	trackedSessions,
	updateTrackedSession,
} from "../state.ts";

function ctx(sessionKey = "session-1", branch = []) {
	return {
		cwd: "/tmp/project",
		sessionManager: {
			getSessionFile: () => sessionKey,
			getBranch: () => branch,
		},
	};
}

function agent(overrides = {}) {
	return {
		id: "agent-a",
		resumable: true,
		kind: "behavioral",
		origin: "user",
		rootDir: "/tmp/agent-a",
		filePath: "/tmp/agent-a/SUBAGENTS.md",
		description: "",
		manifest: true,
		systemPrompt: "",
		...overrides,
	};
}

function result(overrides = {}) {
	return {
		agent: "agent-a",
		agentOrigin: "user",
		task: "task",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 20, turns: 1 },
		contextWindow: 100,
		...overrides,
	};
}

function resetState() {
	trackedSessions.clear();
	subagentSettings.reuseEnabled = true;
	subagentSettings.contextThreshold = 0.6;
}

afterEach(resetState);

test("required session intent handles non-resumable, disabled, and missing records", () => {
	resetState();
	assert.deepEqual(getRequiredSessionIntent(ctx(), agent({ resumable: false })), { intent: "new", reason: "non-resumable" });
	subagentSettings.reuseEnabled = false;
	assert.deepEqual(getRequiredSessionIntent(ctx(), agent()), { intent: "new", reason: "reuse-disabled" });
	subagentSettings.reuseEnabled = true;
	assert.deepEqual(getRequiredSessionIntent(ctx(), agent()), { intent: "new", reason: "none" });
});

test("tracked sessions resume under threshold and restart over threshold", () => {
	resetState();
	const context = ctx();
	const config = agent();
	const under = result();
	updateTrackedSession(context, config, "child-session", under);
	assert.equal(under.nextSessionIntent, "resume");
	assert.equal(getRequiredSessionIntent(context, config).intent, "resume");
	const over = result({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 80, turns: 1 } });
	updateTrackedSession(context, config, "child-session-2", over);
	assert.equal(over.nextSessionIntent, "new");
	assert.equal(getRequiredSessionIntent(context, config).reason, "over-threshold");
});

test("failed or sessionless resumable calls require a new session", () => {
	const failed = result({ exitCode: 1 });
	updateTrackedSession(ctx(), agent(), "child-session", failed);
	assert.equal(failed.nextSessionIntent, "new");
	const missing = result();
	updateTrackedSession(ctx(), agent(), undefined, missing);
	assert.equal(missing.nextSessionIntent, "new");
});

test("restoreSubagentState reads only the singular state identifier", () => {
	assert.equal(SUBAGENT_STATE_ENTRY, "subagent-state");
	const branch = [
		{ type: "custom", customType: "subprocess-state", data: { settings: { reuseEnabled: false, contextThreshold: 0.2 }, sessions: [] } },
		{ type: "custom", customType: "subagents-state", data: { settings: { reuseEnabled: false, contextThreshold: 0.3 }, sessions: [] } },
		{
			type: "custom",
			customType: SUBAGENT_STATE_ENTRY,
			data: {
				settings: { reuseEnabled: true, contextThreshold: 0.8 },
				sessions: [{ mainSessionKey: "session-2", agentId: "agent-a", sessionId: "child", nextIntent: "resume", reason: "under-threshold", contextTokens: 10, updatedAt: 1 }],
			},
		},
	];
	restoreSubagentState(ctx("session-2", branch));
	assert.equal(subagentSettings.contextThreshold, 0.8);
	assert.equal(getRequiredSessionIntent(ctx("session-2"), agent()).intent, "resume");
});

test("restoreSubagentState clears stale in-memory state when branch has no new state", () => {
	trackedSessions.set("stale", { mainSessionKey: "old", agentId: "a", sessionId: "child", nextIntent: "resume", reason: "under-threshold", contextTokens: 1, updatedAt: 1 });
	subagentSettings.contextThreshold = 0.9;
	restoreSubagentState(ctx("new", []));
	assert.equal(trackedSessions.size, 0);
	assert.equal(subagentSettings.contextThreshold, 0.6);
});

test("wrong-intent errors explain major reasons", () => {
	assert.match(formatWrongIntentReason(agent({ resumable: false }), "resume", "new", "non-resumable"), /not resumable/);
	assert.match(formatWrongIntentReason(agent(), "resume", "new", "over-threshold"), /over the context limit/);
	assert.match(formatWrongIntentReason(agent(), "resume", "new", "none"), /no prior reusable session/);
});
