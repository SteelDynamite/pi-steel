import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Pi caches configuration paths on import; load the actual root host only in this child.
if (process.env.RECAP_HOST_CHILD !== "1") {
	test("Pi 1.4 recap context, routing, and bounded lifecycle", { timeout: 30_000 }, () => {
		const home = mkdtempSync(join(tmpdir(), "recap-host-"));
		try {
			const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)], {
				env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), RECAP_HOST_CHILD: "1", PI_OFFLINE: "1" },
				encoding: "utf8", timeout: 25_000,
			});
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
} else {
	globalThis.fetch = async () => { throw new Error("Network forbidden in recap tests"); };
	const host = new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/", import.meta.url);
	const { SessionManager, ModelRuntime, ModelRegistry } = await import(new URL("index.js", host).href);
	const { loadExtensions } = await import(new URL("core/extensions/loader.js", host).href);
	const { createAssistantMessageEventStream } = await import(new URL("../../../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url).href);
	const runtime = await ModelRuntime.create({
		authPath: join(process.env.HOME!, "auth.json"), modelsPath: join(process.env.HOME!, "models.json"),
		modelsStorePath: join(process.env.HOME!, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false,
	});
	let reason = "stop";
	let block = false;
	let requests: any[] = [];
	let pending: Array<() => void> = [];
	let routed = 0;
	const message = (stopReason = "stop", text = "Verified progress; validation remains pending."): any => ({
		role: "assistant", api: "recap-fixture", provider: "recap-fixture", model: "physical",
		content: [{ type: "text", text }], stopReason, timestamp: Date.now(),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	runtime.registerProvider("recap-fixture", {
		api: "recap-fixture", apiKey: "local-fixture-not-a-credential", baseUrl: "http://invalid.invalid",
		models: [{ id: "physical", name: "Physical", reasoning: false, input: ["text"], contextWindow: 128000,
			maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model: any, context: any, options: any) {
			requests.push({ model, context, options });
			const stream = createAssistantMessageEventStream();
			const response = message(reason);
			const finish = () => {
				stream.push(reason === "error" || reason === "aborted"
					? { type: "error", reason, error: response } : { type: "done", reason, message: response });
				stream.end();
			};
			// Intentionally ignore cancellation to verify the extension's own bound and late-result guard.
			if (block) pending.push(finish); else finish();
			return stream;
		},
	});
	const physical = runtime.getModel("recap-fixture", "physical")!;
	runtime.registerVirtualModel({ provider: "recap-router", id: "auto", name: "Auto", route(input: any) {
		assert.equal(input.reason, "direct"); routed++;
		return { model: physical, thinkingLevel: "off" };
	} });

	// Use Pi's real loader and aliases, not the module's older standalone dependency tree.
	const wrapper = join(process.env.HOME!, "recap.ts");
	writeFileSync(wrapper, `import { createRecapExtension } from ${JSON.stringify(fileURLToPath(new URL("../index.ts", import.meta.url)))};\nexport default createRecapExtension({idleDelayMs: 5, retryDelayMs: 5, requestTimeoutMs: 80});\n`);
	const loaded = await loadExtensions([wrapper], process.env.HOME!);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	let manager = SessionManager.inMemory(process.env.HOME!);
	let stored: any[] = [];
	let notices: string[] = [];
	let statuses: Array<string | undefined> = [];
	loaded.runtime.appendEntry = (type: string, data: any) => {
		stored.push(data); manager.appendCustomEntry(type, data);
	};
	const ctx: any = {
		mode: "tui", hasUI: true, model: runtime.getModel("recap-router", "auto"), modelRegistry: new ModelRegistry(runtime),
		sessionManager: manager, isIdle: () => true, hasPendingMessages: () => false, waitForIdle: async () => {},
		ui: { getEditorText: () => "", setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			notify: (value: string) => notices.push(value) },
	};
	const emit = async (name: string) => { for (const handler of extension.handlers.get(name) ?? []) await handler({}, ctx); };
	const command = () => extension.commands.get("recap").handler("", ctx);
	const waitUntil = async (predicate: () => boolean) => {
		const until = Date.now() + 3000;
		while (!predicate()) {
			assert.ok(Date.now() < until, "host fixture did not settle");
			await new Promise(resolve => setTimeout(resolve, 5));
		}
	};
	const reset = async () => {
		await emit("session_shutdown");
		for (const finish of pending.splice(0)) finish();
		manager = SessionManager.inMemory(process.env.HOME!); ctx.sessionManager = manager;
		ctx.signal = undefined; ctx.model = runtime.getModel("recap-router", "auto");
		ctx.isIdle = () => true; ctx.hasPendingMessages = () => false;
		stored = []; notices = []; statuses = []; requests = []; block = false; reason = "stop";
	};
	const exchange = (text: string, stopReason = "stop") => {
		manager.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		return manager.appendMessage(message(stopReason, text));
	};

	const edited = manager.appendMessage({ role: "user", content: "SECRET-original", timestamp: 1 });
	manager.appendContextEdit(edited, { content: "safe replacement" });
	const removed = manager.appendMessage({ role: "user", content: "SECRET-deleted", timestamp: 2 });
	manager.appendContextEdit(removed, null);
	manager.appendMessage(message());
	const assistant = exchange("SECRET-assistant");
	manager.appendContextEdit(assistant, { content: "safe assistant" });
	const tool = manager.appendMessage({ role: "toolResult", toolCallId: "t", toolName: "bash", content: [{ type: "text", text: "SECRET-tool" }], isError: false, timestamp: 3 });
	manager.appendContextEdit(tool, { content: "safe tool" });
	await command();
	assert.equal(stored.length, 1);
	assert.equal(routed, 1);
	assert.equal(requests[0].model.id, "physical");
	assert.doesNotMatch(JSON.stringify(requests[0].context), /SECRET|safe tool/);
	assert.match(JSON.stringify(requests[0].context), /safe replacement/);
	assert.match(JSON.stringify(requests[0].context), /safe assistant/);
	assert.equal(requests[0].context.tools, undefined);
	assert.equal(requests[0].options.cacheRetention, "none");
	assert.equal(manager.buildSessionContext().messages.some((m: any) => m.customType === "pi-recap"), false);

	const kept = manager.appendMessage({ role: "user", content: "SECRET-retained", timestamp: 4 });
	manager.appendCompaction("safe summary", kept, 1000);
	manager.appendContextEdit(kept, { content: "safe retained" });
	await command();
	assert.doesNotMatch(JSON.stringify(requests.at(-1).context), /SECRET|safe replacement|safe assistant/);
	assert.match(JSON.stringify(requests.at(-1).context), /safe retained/);

	for (const failure of ["error", "aborted", "length", "toolUse"]) {
		await reset(); exchange("completed"); ctx.model = physical; reason = failure;
		await command();
		assert.equal(stored.length, 0, failure);
		assert.equal(notices.length, 1, failure);
		assert.equal(statuses.at(-1), undefined);
	}

	await reset();
	for (let i = 0; i < 3; i++) exchange(`SECRET-interrupted-${i}`, i % 2 ? "error" : "aborted");
	await emit("agent_settled");
	await new Promise(resolve => setTimeout(resolve, 25));
	assert.equal(requests.length, 0, "failed assistant turns must not satisfy eligibility");
	exchange("completed"); await command();
	assert.doesNotMatch(JSON.stringify(requests[0].context), /SECRET-interrupted/);
	assert.equal(stored[0].completedTurns, 1);

	for (const event of ["input", "agent_start", "model_select", "session_shutdown"]) {
		await reset(); exchange("completed"); block = true;
		const work = command(); await waitUntil(() => requests.length === 1);
		await emit(event); await work;
		assert.equal(requests[0].options.signal.aborted, true, event);
		for (const finish of pending.splice(0)) finish();
		await new Promise(resolve => setTimeout(resolve, 1));
		assert.equal(stored.length, 0, event);
		assert.equal(notices.length, 0, event);
	}

	await reset(); exchange("completed"); block = true;
	const controller = new AbortController(); ctx.signal = controller.signal;
	const canceled = command(); await waitUntil(() => requests.length === 1); controller.abort(); await canceled;
	assert.equal(stored.length, 0); assert.equal(notices.length, 0);

	await reset(); exchange("completed"); block = true;
	await command(); // Deadline releases the command even though the provider ignores its signal.
	assert.equal(stored.length, 0); assert.match(notices[0], /timed out/);
	assert.equal(statuses.at(-1), undefined);
	for (const finish of pending.splice(0)) finish();
	await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(stored.length, 0);
	block = false; await command(); assert.equal(stored.length, 1, "manual retry remains available");

	await reset(); for (let i = 0; i < 3; i++) exchange(`turn ${i}`); reason = "error";
	await emit("agent_settled");
	await waitUntil(() => requests.length === 2 && notices.length === 1);
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.equal(requests.length, 2, "exactly one automatic retry"); assert.equal(stored.length, 0);
	reason = "stop"; await command(); assert.equal(stored.length, 1);
	await emit("agent_settled"); await new Promise(resolve => setTimeout(resolve, 25));
	assert.equal(requests.length, 3, "successful recap advances eligibility");

	await reset(); for (let i = 0; i < 3; i++) exchange(`turn ${i}`); block = true;
	await emit("agent_settled");
	await waitUntil(() => requests.length === 2 && notices.length === 1);
	assert.match(notices[0], /timed out/);
	assert.equal(stored.length, 0);

	for (const mode of ["rpc", "json", "print", "child"]) {
		await reset(); for (let i = 0; i < 3; i++) exchange(`turn ${i}`);
		ctx.mode = mode === "child" ? "tui" : mode;
		if (mode === "child") process.env.PI_ORCHESTRATED_CHILD = "1";
		await emit("agent_settled"); await new Promise(resolve => setTimeout(resolve, 25));
		assert.equal(requests.length, 0, mode);
		delete process.env.PI_ORCHESTRATED_CHILD;
		ctx.mode = "tui";
	}

	// Lifetime progress must stay comparable to persisted counts after compaction.
	await reset(); for (let i = 0; i < 3; i++) exchange(`turn ${i}`);
	await command(); assert.equal(stored[0].completedTurns, 3);
	const firstKept = manager.appendMessage({ role: "user", content: "new work", timestamp: 6 });
	manager.appendCompaction("summarized old work", firstKept, 1000);
	manager.appendMessage(message()); exchange("more work");
	await emit("agent_settled"); await waitUntil(() => stored.length === 2);
	assert.equal(stored[1].completedTurns, 5);

	for (const change of ["branch", "busy", "pending"]) {
		await reset(); exchange("completed"); block = true;
		const work = command(); await waitUntil(() => requests.length === 1);
		if (change === "branch") manager.appendMessage({ role: "user", content: "new work", timestamp: 5 });
		if (change === "busy") ctx.isIdle = () => false;
		if (change === "pending") ctx.hasPendingMessages = () => true;
		for (const finish of pending.splice(0)) finish(); await work;
		assert.equal(stored.length, 0, change);
	}
	await reset();
	console.log("Pi 1.4 host recap regressions passed");
}
