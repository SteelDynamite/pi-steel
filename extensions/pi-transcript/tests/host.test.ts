import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

if (process.env.TRANSCRIPT_HOST_CHILD !== "1") {
	test("Pi 1.4 canonical rewrites, stale reviews, and auxiliary lifecycle", { timeout: 30_000 }, () => {
		const home = mkdtempSync(join(tmpdir(), "transcript-host-"));
		try {
			const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)], {
				env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), TRANSCRIPT_HOST_CHILD: "1", PI_OFFLINE: "1" },
				encoding: "utf8", timeout: 25_000,
			});
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		} finally { rmSync(home, { recursive: true, force: true }); }
	});
} else {
	globalThis.fetch = async () => { throw new Error("Network forbidden"); };
	const host = new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/", import.meta.url);
	const { SessionManager, ModelRuntime, ModelRegistry, convertToLlm } = await import(new URL("index.js", host).href);
	const { loadExtensions } = await import(new URL("core/extensions/loader.js", host).href);
	const { createAssistantMessageEventStream } = await import(new URL("../../../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url).href);
	const root = fileURLToPath(new URL("../", import.meta.url));
	const wrapper = join(process.env.HOME!, "transcript.ts");
	writeFileSync(wrapper, `import * as context from ${JSON.stringify(join(root, "src/context.ts"))};
import * as rewrite from ${JSON.stringify(join(root, "src/rewrite.ts"))};
import * as summary from ${JSON.stringify(join(root, "src/summarize.ts"))};
Object.assign(globalThis, { transcriptHelpers: { ...context, ...rewrite, ...summary } });
export { default } from ${JSON.stringify(join(root, "index.ts"))};`);
	const loaded = await loadExtensions([wrapper], process.env.HOME!);
	assert.deepEqual(loaded.errors, []);
	const { buildReviewContext, populateRewrittenSession, summarizeBlocks, formatPlainTranscript } = (globalThis as any).transcriptHelpers;
	const extension = loaded.extensions[0];
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const model = { api: "transcript-test", provider: "transcript-test", model: "physical" };
	const user = (content: string) => ({ role: "user", content, timestamp: 1 });
	const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], ...model, usage, stopReason: "stop", timestamp: 2 });
	const session = () => SessionManager.create(process.env.HOME!, process.env.HOME!);
	const context = (manager: any) => convertToLlm(manager.buildSessionContext().messages);
	const rewrite = (manager: any) => {
		const target = session();
		populateRewrittenSession(target, buildReviewContext(manager), new Map(), model);
		return target;
	};

	let manager = session();
	const first = manager.appendMessage(user("SECRET-user"));
	const response = manager.appendMessage(assistant("SECRET-assistant"));
	const tool = manager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "SECRET-tool" }], isError: false, timestamp: 3 });
	manager.appendContextEdit(first, { content: "safe user" });
	manager.appendContextEdit(response, { content: "safe assistant" });
	manager.appendContextEdit(tool, { content: "safe tool" });
	const omitted = manager.appendMessage(user("SECRET-omitted"));
	manager.appendMessage(assistant("retained answer"));
	manager.appendContextEdit(omitted, null);
	const review = buildReviewContext(manager);
	assert.doesNotMatch(JSON.stringify(review), /SECRET/);
	assert.doesNotMatch(formatPlainTranscript(review.blocks), /SECRET/);
	assert.deepEqual(context(rewrite(manager)), context(manager));

	// Edits made after one rewrite remain authoritative when dropping and explicitly restoring later.
	let editedRewrite = rewrite(manager);
	const editedUser = editedRewrite.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "user");
	editedRewrite.appendContextEdit(editedUser.id, { content: "newest redaction" });
	const dropReview = buildReviewContext(editedRewrite);
	dropReview.blocks[0].choice = "drop";
	const dropped = session();
	populateRewrittenSession(dropped, dropReview, new Map(), model);
	const restoreReview = buildReviewContext(dropped);
	restoreReview.blocks[0].choice = "keep";
	const restored = session();
	populateRewrittenSession(restored, restoreReview, new Map(), model);
	assert.match(JSON.stringify(context(restored)), /newest redaction/);
	assert.doesNotMatch(JSON.stringify(context(restored)), /safe user|SECRET/);

	// Compaction inside a turn keeps only its canonical tail and disables block actions.
	manager = session();
	manager.appendMessage(user("SECRET-prefix"));
	const tail = manager.appendMessage(assistant("retained tail"));
	manager.appendMessage(user("recent user")); manager.appendMessage(assistant("recent answer"));
	manager.appendCompaction("latest summary", tail, 100);
	const partial = buildReviewContext(manager);
	assert.equal(partial.blocks[0].readOnlyReason, "pi-compacted");
	assert.doesNotMatch(JSON.stringify(partial), /SECRET/);
	const once = rewrite(manager);
	assert.deepEqual(context(once), context(manager));
	assert.deepEqual(context(rewrite(once)), context(manager));

	// A retained older checkpoint is not a second summary; custom/system chronology survives.
	manager = session();
	manager.appendMessage(user("old")); manager.appendMessage(assistant("old answer"));
	const kept = manager.appendMessage(user("retained"));
	manager.appendMessage(assistant("retained answer"));
	manager.appendCompaction("SUPERSEDED summary", kept, 100);
	manager.appendCustomMessageEntry("notice", "interleaved notice", true);
	manager.appendMessage({ role: "system", content: "system checkpoint", timestamp: 3 });
	manager.appendMessage(user("new user")); manager.appendMessage(assistant("new answer"));
	manager.appendCompaction("latest summary", kept, 100);
	assert.doesNotMatch(JSON.stringify(buildReviewContext(manager)), /SUPERSEDED/);
	assert.deepEqual(context(rewrite(manager)), context(manager));

	// Retained branch summaries survive conversion into ordinary users and repeated rewrites.
	manager = session();
	manager.branchWithSummary(null, "retained branch summary");
	manager.appendMessage(user("first")); manager.appendMessage(assistant("answer"));
	const withBranch = rewrite(manager);
	assert.deepEqual(context(rewrite(withBranch)), context(manager));
	manager = session();
	manager.appendMessage(user("interleaved user"));
	manager.appendCustomMessageEntry("notice", "between user and assistant", true);
	manager.appendMessage(assistant("interleaved answer"));
	assert.deepEqual(context(rewrite(manager)), context(manager));

	// An edited stored summary cannot leak through rewrite metadata or restoration UI.
	const compactReview = buildReviewContext(manager);
	compactReview.blocks[0].choice = "compact";
	const compacted = session();
	populateRewrittenSession(compacted, compactReview, new Map([[compactReview.blocks[0].id, "SECRET-summary"]]), model);
	const summaryId = compacted.getBranch().find((entry: any) => entry.type === "custom_message" && entry.customType === "pi-transcript-compacted").id;
	compacted.appendContextEdit(summaryId, { content: "safe edited summary" });
	assert.doesNotMatch(JSON.stringify(buildReviewContext(compacted)), /SECRET/);
	assert.doesNotMatch(JSON.stringify(context(rewrite(compacted))), /SECRET/);

	const runtime = await ModelRuntime.create({ authPath: join(process.env.HOME!, "auth.json"), modelsPath: join(process.env.HOME!, "models.json"), modelsStorePath: join(process.env.HOME!, "cache.json"), refreshOnCreate: false, allowModelNetwork: false });
	let reason = "stop";
	let pending: (() => void) | undefined;
	let block = false;
	let requests: any[] = [];
	let routed = 0;
	runtime.registerProvider("transcript-test", {
		api: "transcript-test", apiKey: "local-test", baseUrl: "http://invalid.invalid",
		models: [{ id: "physical", name: "Physical", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(_model: any, input: any, options: any) {
			requests.push({ input, options });
			const stream = createAssistantMessageEventStream();
			const finish = () => {
				const content = input.messages.find((message: any) => message.role === "user").content;
				const id = JSON.parse(typeof content === "string" ? content : content.map((part: any) => part.text ?? "").join(""))[0].id;
				const response = { ...assistant(JSON.stringify({ summaries: [{ id, summary: "safe summary" }] })), stopReason: reason };
				stream.push(reason === "error" || reason === "aborted" ? { type: "error", reason, error: response } : { type: "done", reason, message: response });
				stream.end();
			};
			if (block) pending = finish; else finish();
			return stream;
		},
	});
	const physical = runtime.getModel("transcript-test", "physical")!;
	runtime.registerVirtualModel({ provider: "transcript-router", id: "auto", name: "Auto", route() { routed++; return { model: physical, thinkingLevel: "off" }; } });
	let replacements = 0;
	let selection = "Compact";
	let mutate: (() => void) | undefined;
	let idle = true, queued = false;
	const ctx: any = {
		mode: "rpc", hasUI: true, model: runtime.getModel("transcript-router", "auto"), modelRegistry: new ModelRegistry(runtime),
		sessionManager: manager, waitForIdle: async () => {}, isIdle: () => idle, hasPendingMessages: () => queued,
		ui: { editor: async () => { mutate?.(); }, select: async (title: string) => title.startsWith("Block") ? selection : "Apply rewrite", notify(message: string) { if (process.env.TRANSCRIPT_TEST_DEBUG) console.error(message); }, setStatus() {} },
		newSession: async (options: any) => { replacements++; const target = session(); await options.setup(target); await options.withSession(ctx); return { cancelled: false }; },
	};
	const command = () => extension.commands.get("transcript").handler("", ctx);
	const reset = () => {
		manager = session(); manager.appendMessage(user("safe prompt")); manager.appendMessage(assistant("safe answer"));
		ctx.sessionManager = manager; replacements = 0; mutate = undefined; idle = true; queued = false; selection = "Compact"; block = false; reason = "stop"; requests = []; pending = undefined;
	};
	await summarizeBlocks(review.blocks.filter((item: any) => !item.readOnlyReason), ctx);
	assert.doesNotMatch(JSON.stringify(requests[0].input), /SECRET/);
	reset(); await command(); assert.equal(replacements, 1); assert.equal(routed, 2);
	for (const mutation of [() => manager.appendMessage(user("intervening")), () => { idle = false; }, () => { queued = true; }, () => { ctx.sessionManager = session(); }]) {
		reset(); mutate = mutation; await command(); assert.equal(replacements, 0); assert.equal(requests.length, 0);
	}
	for (const failure of ["error", "aborted", "length", "toolUse"]) {
		reset(); reason = failure; await command(); assert.equal(replacements, 0, failure);
	}
	const waitRequest = async () => { while (!requests.length) await new Promise(resolve => setTimeout(resolve, 1)); };
	reset(); block = true;
	const stale = command(); await waitRequest(); manager.appendMessage(user("intervening work")); pending!(); await stale;
	assert.equal(replacements, 0);
	reset(); block = true;
	const canceled = command(); await waitRequest();
	for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	await canceled; assert.equal(requests[0].options.signal.aborted, true); assert.equal(replacements, 0); pending!();
	reset(); block = true;
	await assert.rejects(summarizeBlocks(buildReviewContext(manager).blocks, ctx, undefined, 10), /timed out/);
	assert.equal(requests[0].options.signal.aborted, true); pending!();
	console.log("Pi 1.4 transcript host regressions passed");
}
