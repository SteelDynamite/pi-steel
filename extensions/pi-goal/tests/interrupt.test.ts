import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

if (process.env.GOAL_INTERRUPT_CHILD !== "1") {
	test("real Pi: interrupt clears goals through startup, requests, tools, evaluation and continuation; steering preserves them", { timeout: 60000 }, () => {
		const home = mkdtempSync(join(tmpdir(), "goal-interrupt-"));
		try {
			const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)], {
				cwd: home, encoding: "utf8", timeout: 50000,
				env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1", GOAL_INTERRUPT_CHILD: "1" },
			});
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		} finally { rmSync(home, { recursive: true, force: true }); }
	});
} else {
	globalThis.fetch = async () => { throw new Error("Network forbidden in goal interruption tests"); };
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href);
	const { createAssistantMessageEventStream } = await import(new URL("../../../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url).href);
	const { Type } = await import(new URL("../../../node_modules/typebox/build/index.mjs", import.meta.url).href);
	const { default: goal } = await import("../index.ts");
	const { latestGoalState } = await import("../src/core.ts");
	const cwd = process.env.HOME!;
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	mkdirSync(agentDir, { recursive: true });
	for (const phase of ["startup", "main", "tool", "evaluation", "boundary", "steering"]) {
		let currentPhase = phase;
		let ready!: () => void;
		const started = new Promise<void>(resolve => { ready = resolve; });
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let mainRequests = 0;
		let evaluations = 0;
		const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
			modelsStorePath: join(agentDir, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
		runtime.registerProvider("interrupt-local", {
			api: "interrupt-local", apiKey: "local-test", baseUrl: "http://invalid.invalid",
			models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			streamSimple(model: any, _context: any, options: any) {
				const evaluating = options.sessionId?.endsWith(":pi-goal-evaluator");
				if (evaluating) evaluations++; else mainRequests++;
				const stream = createAssistantMessageEventStream();
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					timestamp: Date.now(), content: [], stopReason: "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				queueMicrotask(async () => {
					if ((currentPhase === "main" && !evaluating) || (currentPhase === "evaluation" && evaluating)) {
						const abort = () => { message.stopReason = "aborted"; stream.push({ type: "error", reason: "aborted", error: message }); stream.end(); };
						if (options.signal.aborted) abort(); else options.signal.addEventListener("abort", abort, { once: true });
						ready();
						return;
					}
					if (currentPhase === "steering" && !evaluating && mainRequests === 1) { ready(); await gate; }
					if (currentPhase === "tool" && !evaluating) {
						message.content = [{ type: "toolCall", id: "blocked-tool", name: "wait_for_interrupt", arguments: {} }];
						message.stopReason = "toolUse";
					} else message.content = [{ type: "text", text: evaluating
						? JSON.stringify({ met: currentPhase !== "boundary", reason: "fixture evidence" }) : "fixture response" }];
					stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
				});
				return stream;
			},
		});
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true,
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [goal, (pi: any) => {
				pi.on("before_agent_start", async () => { if (currentPhase === "startup") { ready(); await gate; } });
				pi.on("turn_end", async (event: any) => {
					if (currentPhase === "boundary" && event.continue) { ready(); await gate; }
				});
				pi.registerTool({ name: "wait_for_interrupt", label: "Wait", description: "Local interrupt fixture", parameters: Type.Object({}),
					async execute(_id: string, _args: unknown, signal: AbortSignal) {
						await new Promise<void>(resolve => {
							if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
							ready();
						});
						return { content: [{ type: "text", text: "interrupted" }], details: undefined };
					},
				});
			}] });
		await loader.reload();
		const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
		const { session } = await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader,
			modelRuntime: runtime, model: runtime.getModel("interrupt-local", "fixture"), sessionManager: manager, noTools: true });
		const errors: unknown[] = [];
		try {
			await session.bindExtensions({ mode: "rpc", onError: (error: unknown) => errors.push(error) });
			await session.prompt("/goal finish the fixture");
			await started;
			assert.equal(latestGoalState(manager.getBranch())?.status, "active", phase);
			if (phase === "steering") {
				await session.steer("change direction without stopping");
				assert.equal(latestGoalState(manager.getBranch())?.status, "active");
				release();
				await session.waitForIdle();
				assert.equal(latestGoalState(manager.getBranch())?.status, "achieved");
				assert.equal(manager.getBranch().some((entry: any) => entry.type === "custom" && entry.data?.stopReason === "run interrupted"), false);
			} else {
				const interrupt = session.abort();
				release();
				await interrupt;
				assert.equal(latestGoalState(manager.getBranch())?.status, "cleared", phase);
				assert.equal(latestGoalState(manager.getBranch())?.stopReason, "run interrupted", phase);
				assert.equal(mainRequests, phase === "startup" ? 0 : 1, "interrupt must not dispatch another main request");
				const stored = SessionManager.open(manager.getSessionFile()!);
				assert.equal(latestGoalState(stored.getBranch())?.status, "cleared");
				currentPhase = "after";
				const count = evaluations;
				await session.reload();
				await session.prompt("unrelated work after interruption");
				assert.equal(evaluations, count, "reload must not reactivate the goal");
				assert.equal(latestGoalState(manager.getBranch())?.status, "cleared");
			}
			assert.deepEqual(errors, [], phase);
			console.log(`${phase}: passed`);
		} finally { session.dispose(); }
	}
}
