import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { reconstructTodoModelFromBranch, type TodoDetails } from "../src/todo-core.ts";

if (!process.env.TODO_HOST_CHILD) {
	test("real Pi: direct/nested persistence, reload/tree, errors, abort, and child suppression", { timeout: 60000 }, () => {
		const home = mkdtempSync(join(tmpdir(), "todo-host-"));
		try {
			for (const child of ["0", "1"]) {
				const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)], {
					cwd: home, encoding: "utf8", timeout: 25000,
					env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, child), PI_OFFLINE: "1", TODO_HOST_CHILD: "1", PI_ORCHESTRATED_CHILD: child },
				});
				assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
			}
		} finally { rmSync(home, { recursive: true, force: true }); }
	});
} else {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const cwd = process.env.HOME!;
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	mkdirSync(agentDir, { recursive: true });
	const state: any = { requests: 0 };
	(globalThis as any).__todoHost = state;
	const settings = SettingsManager.create(cwd, agentDir);
	settings.setCompactionEnabled(false);
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
		additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url)), fileURLToPath(new URL("./host-fixture.ts", import.meta.url))],
		noSkills: true, noPromptTemplates: true, noThemes: true });
	await loader.reload();
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
	const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
	const { session } = await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime: runtime, sessionManager: manager });
	const errors: unknown[] = [];
	await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
	await session.setModel(runtime.getModel("todo-local", "fixture")!);
	const current = () => reconstructTodoModelFromBranch(manager.getBranch());
	const remindersCount = () => manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "system-reminder").length;
	async function action(value: unknown, nested = true) {
		state.action = value; state.nested = nested; state.call = true;
		await session.prompt("test operation");
		assert.deepEqual(errors, []);
	}
	try {
		await action({ action: "add", items: ["direct"], replace: true }, false);
		const directLeaf = manager.getLeafId()!;
		await action({ action: "add", items: ["nested"] });
		await action({ action: "complete", id: 2, state: "done" });
		const completedLeaf = manager.getLeafId()!;
		assert.equal(current().todos[1]?.state, "done");
		await session.reload();
		await action({ action: "list" });
		assert.equal(state.result.details.todos[1].state, "done");
		assert.equal(SessionManager.open(manager.getSessionFile()!).getBranch().filter(entry => entry.type === "custom" && entry.customType === "pi-todo-state").length, 3);
		await action({ action: "clear" });
		await session.reload();
		await action({ action: "list" });
		assert.deepEqual(state.result.details.todos, []);
		await session.navigateTree(directLeaf, { summarize: false });
		await action({ action: "list" });
		assert.equal(state.result.details.todos.length, 1);
		await session.navigateTree(completedLeaf, { summarize: false });
		await action({ action: "list" });
		assert.equal(state.result.details.todos[1].state, "done");
		for (const value of [{ action: "add" }, { action: "complete" }, { action: "complete", id: 1 }, { action: "complete", id: 999, state: "done" }]) {
			await action(value);
			assert.equal(state.result.isError, true);
			await action(value, false);
			const results = manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "toolResult");
			const last = results.at(-1)!;
			assert.ok(last.type === "message" && last.message.role === "toolResult" && last.message.isError);
		}
		// Abort a real pending provider request, then navigate and prompt. No queued reminder survives.
		let started!: () => void;
		const waiting = new Promise<void>(resolve => { started = resolve; });
		state.abort = true; state.started = started;
		const remindersBeforeAbort = remindersCount();
		const requestsBeforeAbort = state.requests;
		const pending = session.prompt("abort request");
		await waiting;
		await session.abort();
		await pending;
		state.abort = false;
		assert.equal(remindersCount(), remindersBeforeAbort);
		assert.equal(state.requests, requestsBeforeAbort + 1);
		const reminders = remindersCount;
		assert.equal(session.getSteeringMessages().length, 0);
		await session.navigateTree(directLeaf, { summarize: false });
		await session.prompt("after abort");
		assert.equal(reminders(), 0);
		await session.navigateTree(completedLeaf, { summarize: false });
		const count = reminders();
		const requests = state.requests;
		await session.prompt("normal reminder");
		const child = process.env.PI_ORCHESTRATED_CHILD === "1";
		assert.equal(reminders() - count, child ? 0 : 1, JSON.stringify({ boundaries: state.boundaries, current: current() }));
		assert.equal(state.requests - requests, child ? 1 : 2);
		// A slow direct result must not overwrite a newer nested mutation on reload.
		state.siblings = true;
		await action({ action: "complete", id: 1, state: "done" });
		state.siblings = false;
		const siblingBranch = manager.getBranch();
		const doneSnapshot = siblingBranch.map(entry => entry.type === "custom" && entry.customType === "pi-todo-state").lastIndexOf(true);
		assert.ok(siblingBranch.slice(doneSnapshot + 1).some(entry => {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") return false;
			return (entry.message.details as TodoDetails | undefined)?.todos[0]?.state === "pending";
		}), "stale direct echo follows the newer custom state");
		await session.reload();
		await action({ action: "list" });
		assert.equal(state.result.details.todos[0].state, "done");
		assert.deepEqual(errors, []);
	} finally { session.dispose(); }
}
