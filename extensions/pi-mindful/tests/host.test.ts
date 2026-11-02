import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Import Pi only after process isolation: its paths are cached during import.
if (!process.env.MINDFUL_HOST_TEST) {
	for (const child of ["0", "1"]) {
		test(`actual Pi loader, runner, and UI (orchestrated child=${child})`, async () => {
			const home = await mkdtemp(join(tmpdir(), "mindful-host-"));
			try {
				const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)], {
					env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
						PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1",
						MINDFUL_HOST_TEST: "1", PI_ORCHESTRATED_CHILD: child },
					encoding: "utf8", timeout: 20_000,
				});
				assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		});
	}
} else {
	test("mindful preserves host indicator and cleans only its widget", async (t) => {
		globalThis.fetch = async () => { throw new Error("Network forbidden in mindful tests"); };
		const host = new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/", import.meta.url);
		const { loadExtensions } = await import(new URL("core/extensions/loader.js", host).href);
		const { ExtensionRunner } = await import(new URL("core/extensions/runner.js", host).href);
		const { InteractiveMode } = await import(new URL("modes/interactive/interactive-mode.js", host).href);
		const { SessionManager } = await import(new URL("core/session-manager.js", host).href);
		const configPath = join(process.env.HOME!, ".pi", "agent", "mindful.json");
		await mkdir(join(process.env.HOME!, ".pi", "agent"), { recursive: true });
		const configure = (enabled: boolean, delaySeconds = 0) => writeFile(configPath, JSON.stringify({ enabled, delaySeconds }));
		await configure(false);
		const loaded = await loadExtensions([fileURLToPath(new URL("../index.ts", import.meta.url))], process.env.HOME!);
		assert.deepEqual(loaded.errors, []);
		const extension = loaded.extensions[0];
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.env.HOME!, SessionManager.inMemory(), {});
		const errors: unknown[] = [];
		runner.onError((error: unknown) => errors.push(error));
		// Real host mutators on a terminal-free receiver; no mocked indicator/widget semantics.
		const ui = Object.create(InteractiveMode.prototype);
		ui.ui = { requestRender() {} };
		ui.extensionWidgetsAbove = new Map();
		ui.extensionWidgetsBelow = new Map();
		const indicator = { frames: ["other-extension"], interval: 100 };
		ui.setWorkingIndicator(indicator);
		ui.setExtensionWidget("other-extension", ["untouched"]);
		let mutations = 0;
		runner.setUIContext({
			setWorkingIndicator(value: unknown) { mutations++; ui.setWorkingIndicator(value); },
			setWidget(...args: unknown[]) { mutations++; ui.setExtensionWidget(...args); },
			notify() { mutations++; },
		}, "tui");
		const emit = (type: string) => runner.emit({ type });
		const command = (args: string) => extension.commands.get("mindful").handler(args, runner.createContext());
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		await emit("session_start");
		await emit("agent_start");
		t.mock.timers.tick(1000);
		assert.equal(ui.workingIndicatorOptions, indicator);
		assert.equal(ui.extensionWidgetsBelow.has("pi-mindful"), false);
		if (process.env.PI_ORCHESTRATED_CHILD === "1") {
			await configure(true);
			await emit("agent_start");
			t.mock.timers.tick(1000);
			await emit("agent_end");
			await emit("session_shutdown");
			assert.equal(extension.commands.has("mindful"), true);
			assert.equal(mutations, 0);
			await command("off");
			assert.equal(mutations, 1, "explicit command only reports disabled status");
			assert.equal(JSON.parse(await readFile(configPath, "utf8")).enabled, true);
		} else {
			await command("on");
			await emit("agent_start");
			t.mock.timers.tick(0);
			assert.equal(ui.extensionWidgetsBelow.has("pi-mindful"), true);
			await command("off");
			assert.equal(JSON.parse(await readFile(configPath, "utf8")).enabled, false);
			assert.equal(ui.extensionWidgetsBelow.has("pi-mindful"), false);
			const stopped = mutations;
			t.mock.timers.tick(1000);
			assert.equal(mutations, stopped);
			for (const end of ["agent_end", "session_shutdown"]) {
				await configure(true, 1);
				await emit("agent_start");
				await emit(end);
				const before = mutations;
				t.mock.timers.tick(2000);
				assert.equal(mutations, before, `${end} cancels delayed display`);
				await configure(true);
				await emit("agent_start");
				t.mock.timers.tick(0);
				await emit(end);
				assert.equal(ui.extensionWidgetsBelow.has("pi-mindful"), false);
			}
		}
		assert.equal(ui.workingIndicatorOptions, indicator);
		assert.equal(ui.extensionWidgetsAbove.has("other-extension"), true);
		assert.deepEqual(errors, []);
	});
}
