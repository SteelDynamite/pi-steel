import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Start before importing Pi: configuration paths are cached at module load.
if (process.env.GOAL_HOST_CHILD !== "1") {
	test("Pi 1.4 effective context, routed evaluation and clear cancellation", { timeout: 30000 }, () => {
		const home = mkdtempSync(join(tmpdir(), "goal-host-"));
		try {
			const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)], {
				env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), GOAL_HOST_CHILD: "1", PI_OFFLINE: "1" },
				encoding: "utf8", timeout: 25000,
			});
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
} else {
	// Fetch must never reach a live provider, including through an accidental default model.
	globalThis.fetch = async () => { throw new Error("Network forbidden in goal tests"); };
	const { SessionManager, ModelRuntime, ModelRegistry, AgentSession } = await import(new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href);
	const { createAssistantMessageEventStream } = await import(new URL("../../../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url).href);
	const { default: goalExtension } = await import("../index.ts");
	const { createActiveGoal, GOAL_STATE_ENTRY, latestGoalState } = await import("../src/core.ts");
	const runtime = await ModelRuntime.create({
		authPath: join(process.env.HOME!, "auth.json"), modelsPath: join(process.env.HOME!, "models.json"),
		modelsStorePath: join(process.env.HOME!, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false,
	});
	let request: any;
	let block = false;
	let responseReason = "stop";
	let started!: () => void;
	let aborted = false;
	let routes = 0;
	runtime.registerProvider("goal-fixture", {
		api: "goal-fixture", apiKey: "local-test-not-a-credential", baseUrl: "http://invalid.invalid",
		models: [{ id: "physical", name: "Physical", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model: any, context: any, options: any) {
			request = { model, context, options };
			const stream = createAssistantMessageEventStream();
			const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text: '{"met":true,"reason":"proof"}' }], stopReason: responseReason, timestamp: 1,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			if (block) {
				options.signal.addEventListener("abort", () => {
					aborted = true;
					message.stopReason = "aborted";
					stream.push({ type: "error", reason: "aborted", error: message });
					stream.end();
				}, { once: true });
				started();
			} else {
				stream.push(responseReason === "stop" ? { type: "done", reason: "stop", message } : { type: "error", reason: responseReason, error: message });
				stream.end();
			}
			return stream;
		},
	});
	const physical = runtime.getModel("goal-fixture", "physical")!;
	runtime.registerVirtualModel({ provider: "goal-router", id: "virtual", name: "Virtual", route(input: any) {
		assert.equal(input.reason, "direct"); routes++;
		return { model: physical, thinkingLevel: "off" };
	} });
	const manager = SessionManager.inMemory(process.env.HOME!);
	const raw = manager.appendMessage({ role: "user", content: "SECRET-original", timestamp: 1 });
	manager.appendContextEdit(raw, { content: "redacted-safe" });
	const removed = manager.appendMessage({ role: "user", content: "SECRET-omitted", timestamp: 2 });
	manager.appendContextEdit(removed, null);
	manager.appendCustomMessageEntry("goal-context", "SECRET-supervisor", true);
	manager.appendCustomEntry(GOAL_STATE_ENTRY, createActiveGoal("prove tests"));
	const handlers = new Map<string, Function>();
	const commands = new Map<string, Function>();
	goalExtension({
		appendEntry: (type, data) => { manager.appendCustomEntry(type, data); },
		sendMessage: () => {}, sendUserMessage: () => {},
		on: (event, handler) => { handlers.set(event, handler); },
		registerCommand: (name, command) => { commands.set(name, command.handler); },
	});
	const ctx: any = { sessionManager: manager, modelRegistry: new ModelRegistry(runtime), model: runtime.getModel("goal-router", "virtual"),
		signal: new AbortController().signal, hasPendingMessages: () => false, ui: { setStatus() {} } };
	// Use Pi's real preview builder and ordered boundary dispatcher, without starting a main model run.
	const { ExtensionRunner } = await import(new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js", import.meta.url).href);
	const session = Object.create(AgentSession.prototype);
	Object.assign(session, { sessionManager: manager, _cwd: process.env.HOME, _pendingCustomMessages: [],
		agent: { peekQueuedMessages: () => [], hasQueuedMessages: () => false } });
	const runner = Object.create(ExtensionRunner.prototype);
	let drafts: any[] = [];
	Object.assign(runner, { createContext: () => ctx, emitError: (error: any) => { throw new Error(error.error); }, extensions: [
		{ path: "earlier-redactor", handlers: new Map([["turn_end", [() => ({ entries: drafts })]]]) },
		{ path: "goal", handlers: new Map([["turn_end", [(event: any, context: any) => handlers.get("turn_end")!(event, context)]]]) },
	] });
	const turn = { type: "turn_end", outcome: "completed", message: { role: "assistant", stopReason: "stop" }, entries: [] };
	const emitTurn = () => runner.emitBoundary(turn, (entries: any[]) => session._buildBoundaryContext(entries, "turn_end"));
	await handlers.get("session_start")!({}, ctx);
	const draftEdited = manager.appendMessage({ role: "user", content: "SECRET-draft-edit", timestamp: 2 });
	const draftRemoved = manager.appendMessage({ role: "user", content: "SECRET-draft-remove", timestamp: 2 });
	drafts = [
		{ type: "context_edit", targetId: draftEdited, replacement: { content: "safe boundary replacement" } },
		{ type: "context_edit", targetId: draftRemoved, replacement: null },
	];
	const boundary = await emitTurn();
	assert.equal(boundary.valid, true);
	assert.deepEqual(boundary.entries.slice(0, drafts.length), drafts);
	assert.match(JSON.stringify(request.context), /safe boundary replacement/);
	assert.match(JSON.stringify(manager.buildSessionProjection().messages), /SECRET-draft-edit/);
	assert.equal(manager.getEntry(draftRemoved).message.content, "SECRET-draft-remove");
	// The draft edits remain uncommitted throughout evaluation.
	assert.equal(routes, 1);
	assert.equal(request.model.id, "physical");
	assert.doesNotMatch(JSON.stringify(request.context), /SECRET/);
	assert.match(JSON.stringify(request.context), /redacted-safe/);
	assert.equal(request.context.tools, undefined);
	assert.equal(request.options.cacheRetention, "short");
	assert.match(request.options.sessionId, /:pi-goal-evaluator$/);
	assert.equal(latestGoalState(manager.getBranch())?.status, "achieved");

	// Compaction must not resurrect raw history; edits on retained entries still apply.
	const compacted = manager.appendMessage({ role: "user", content: "SECRET-compacted", timestamp: 3 });
	const retained = manager.appendMessage({ role: "user", content: "SECRET-retained", timestamp: 4 });
	manager.appendCompaction("safe compaction summary", retained, 1000);
	manager.appendContextEdit(retained, { content: "safe retained content" });
	manager.appendCustomEntry(GOAL_STATE_ENTRY, createActiveGoal("prove tests"));
	await handlers.get("session_start")!({}, ctx);
	drafts = [];
	await emitTurn();
	assert.doesNotMatch(JSON.stringify(request.context), /SECRET/);
	assert.match(JSON.stringify(request.context), /safe compaction summary/);
	assert.match(JSON.stringify(request.context), /safe retained content/);
	assert.ok(manager.getEntry(compacted), "raw history remains recoverable, not evaluator evidence");

	// Physical dispatch and failed responses must not accept parseable success JSON.
	ctx.model = physical;
	for (const reason of ["error", "aborted"]) {
		responseReason = reason;
		manager.appendCustomEntry(GOAL_STATE_ENTRY, createActiveGoal("prove tests"));
		await handlers.get("session_start")!({}, ctx);
		await emitTurn();
		assert.notEqual(latestGoalState(manager.getBranch())?.status, "achieved");
	}

	// Clear cancels only the goal-owned auxiliary call, not the main turn signal.
	manager.appendCustomEntry(GOAL_STATE_ENTRY, createActiveGoal("prove tests"));
	await handlers.get("session_start")!({}, ctx);
	block = true;
	const ready = new Promise<void>(resolve => { started = resolve; });
	const evaluation = emitTurn();
	await ready;
	await commands.get("goal")!("clear", ctx);
	assert.deepEqual((await evaluation).entries, []);
	assert.equal(aborted, true);
	assert.equal(ctx.signal.aborted, false);
	assert.equal(latestGoalState(manager.getBranch())?.status, "cleared");
	console.log("Host context, routing, response failure, and evaluator cancellation passed");
}
