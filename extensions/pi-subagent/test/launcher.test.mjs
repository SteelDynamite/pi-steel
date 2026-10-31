import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { useFakePi } from "./fixtures/pi-host.mjs";
import { getPiInvocation, runDelegation } from "../execution.ts";
import { trackedSessions } from "../state.ts";

const details = (results) => ({ includeLocationalAgents: false, locationalAgents: [], results });

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-launcher-"));
	const script = join(root, "worker.cjs");
	const restorePi = useFakePi(root, script);
	const argv = [...process.argv];
	const execPath = Object.getOwnPropertyDescriptor(process, "execPath");
	const bun = Object.getOwnPropertyDescriptor(process.versions, "bun");
	t.after(() => {
		process.argv = argv;
		Object.defineProperty(process, "execPath", execPath);
		if (bun) Object.defineProperty(process.versions, "bun", bun);
		else delete process.versions.bun;
		restorePi();
		rmSync(root, { recursive: true, force: true });
	});
	writeFileSync(script, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "worker" }] } }));`);
	const agent = { id: "test", description: "", manifest: true, systemPrompt: "launcher test", origin: "user", kind: "behavioral", rootDir: root, filePath: join(root, "agent.md"), resumable: false };
	const ctx = { cwd: root, isProjectTrusted: () => true, sessionManager: { getBranch: () => [] }, model: { provider: "caller", id: "default" }, modelRegistry: { getAvailable: () => [{ provider: "provider", id: "explicit" }] } };
	const launch = (id = agent.id) => runDelegation({ appendEntry() { assert.fail("No session state should be persisted"); } }, ctx, root, [agent], id, "new", "test", undefined, undefined, details, false);
	return { root, script, launch };
}

for (const name of ["pi-bot.cjs", "custom-entrypoint.cjs", "cli.js"]) {
	test(`SDK host ${name} is never executed; package CLI receives inherited environment`, async (t) => {
		const { root, script, launch } = fixture(t);
		const marker = join(root, "host-executed");
		const host = join(root, name);
		writeFileSync(host, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "host ran");`);
		process.argv[1] = host;
		const record = join(root, "worker.json");
		writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), marker: process.env.PI_ORCHESTRATED_CHILD, sentinel: process.env.PI_LAUNCH_TEST_SENTINEL }));`);
		const old = process.env.PI_LAUNCH_TEST_SENTINEL;
		process.env.PI_LAUNCH_TEST_SENTINEL = "inherited-no-credentials";
		t.after(() => { if (old === undefined) delete process.env.PI_LAUNCH_TEST_SENTINEL; else process.env.PI_LAUNCH_TEST_SENTINEL = old; });
		const result = await launch();
		assert.equal(result.exitCode, 0);
		assert.equal(existsSync(marker), false);
		const call = JSON.parse(readFileSync(record, "utf8"));
		assert.equal(call.cwd, root);
		assert.equal(call.marker, "1");
		assert.equal(call.sentinel, "inherited-no-credentials");
		assert.deepEqual(call.args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
		assert.equal(existsSync(call.args[call.args.indexOf("--append-system-prompt") + 1]), false);
	});
}

test("ordinary Pi startup, symlink and absent argv select the declared bundled or unbundled CLI", async (t) => {
	const { root, script } = fixture(t);
	const args = ["--version"];
	const link = join(root, "pi");
	symlinkSync(script, link);
	const sourceEntry = join(root, "src", "cli.ts");
	mkdirSync(join(root, "src"));
	writeFileSync(sourceEntry, "// Source startup still selects the built package CLI.");
	for (const entry of [script, link, sourceEntry, undefined, "/missing/custom.js"]) {
		process.argv[1] = entry;
		assert.deepEqual(await getPiInvocation(args), { command: process.execPath, args: [script, ...args] });
	}
	for (const bin of ["dist/cli.js", "dist/bundle/cli.js"]) {
		const target = join(root, bin);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, "");
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: bin } }));
		assert.deepEqual(await getPiInvocation(args), { command: process.execPath, args: [target, ...args] });
	}
});

test("Bun script runtime and packaged Bun executable retain their invocation forms", async (t) => {
	const { root, script } = fixture(t);
	Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.3.0" });
	Object.defineProperty(process, "execPath", { configurable: true, value: join(root, "bun") });
	assert.deepEqual(await getPiInvocation(["--version"]), { command: process.execPath, args: [script, "--version"] });
	const binary = join(root, process.platform === "win32" ? "pi.exe" : "pi");
	writeFileSync(binary, "inert binary fixture; never execute");
	Object.defineProperty(process, "execPath", { configurable: true, value: binary });
	process.argv[1] = "/$bunfs/root/pi";
	rmSync(script);
	assert.deepEqual(await getPiInvocation(["--version"]), { command: binary, args: ["--version"] });
});

for (const invalid of ["missing-host-location", "missing-package", "malformed-package", "wrong-package", "missing-bin", "missing-cli", "directory-cli", "custom-executable", "compiled-sdk-host"]) {
	test(`launcher fails closed for ${invalid}, without spawning or model fallback`, async (t) => {
		const { root, script, launch } = fixture(t);
		process.argv[1] = join(root, "pi-bot.cjs");
		writeFileSync(process.argv[1], "throw new Error('host must never run');");
		if (invalid === "missing-host-location") delete process.env.PI_PACKAGE_DIR;
		if (invalid === "missing-package") rmSync(join(root, "package.json"));
		if (invalid === "malformed-package") writeFileSync(join(root, "package.json"), "{");
		if (invalid === "wrong-package") writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-bot", bin: { pi: "pi-bot.cjs" } }));
		if (invalid === "missing-bin") writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
		if (invalid === "missing-cli" || invalid === "directory-cli") rmSync(script);
		if (invalid === "directory-cli") mkdirSync(script);
		if (invalid === "custom-executable" || invalid === "compiled-sdk-host") {
			Object.defineProperty(process, "execPath", { configurable: true, value: process.argv[1] });
			if (invalid === "compiled-sdk-host") {
				writeFileSync(join(root, process.platform === "win32" ? "pi.exe" : "pi"), "inert sibling; never execute");
				Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.3.0" });
				process.argv[1] = "/$bunfs/root/pi-bot";
			}
		}
		// A locational explicit model would ordinarily permit a provider fallback.
		writeFileSync(join(root, "SUBAGENTS.md"), "---\nmodel: provider/explicit\n---\n");
		const before = new Map(trackedSessions);
		let spawns = 0;
		const mock = t.mock.method(childProcess, "spawn", () => { spawns++; assert.fail("Must fail before spawn"); });
		syncBuiltinESMExports();
		try {
			const result = await launch(root);
			assert.equal(result.exitCode, 1);
			assert.match(result.errorMessage, /Cannot identify Pi CLI; refusing to launch the host process/);
			assert.equal(result.warning, undefined);
			assert.equal(spawns, 0);
			assert.deepEqual(trackedSessions, before);
		} finally {
			mock.mock.restore();
			syncBuiltinESMExports();
		}
	});
}
