import assert from "node:assert/strict";
import { useFakePi } from "./fixtures/pi-host.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyContextLimitFailure, runDelegation, shouldRetryPreferredModelFailure } from "../execution.ts";

const details = (results) => ({ includeLocationalAgents: false, locationalAgents: [], results });

for (const scenario of ["trust-denied", "trust-allowed", "abort-after-answer", "abort-provider-error", "already-aborted"]) {
	test(`delegation safety: ${scenario}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-delegation-safety-"));
		const restorePi = useFakePi(root, join(root, "fake-pi.cjs"));
		const controller = new AbortController();
		const originalSpawn = childProcess.spawn;
		let spawnCount = 0;
		childProcess.spawn = (...args) => { spawnCount++; return originalSpawn(...args); };
		syncBuiltinESMExports();
		try {
			const record = join(root, "launches.jsonl");
			const script = join(root, "fake-pi.cjs");
			writeFileSync(script, `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n");
${scenario.startsWith("abort-") ? `
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
console.log(JSON.stringify({ type: "message_end", message: {
  role: "assistant", stopReason: ${JSON.stringify(scenario === "abort-provider-error" ? "error" : "stop")},
  ${scenario === "abort-provider-error" ? 'errorMessage: "provider unavailable",' : ""}
  content: ${scenario === "abort-provider-error" ? "[]" : '[{ type: "text", text: "answer before shutdown" }]'}
} }));` : ""}
`);
			const local = scenario === "abort-provider-error";
			if (local) writeFileSync(join(root, "SUBAGENTS.md"), "---\nmodel: provider/explicit\nresumable: false\n---\n");
			const agent = { id: "test", description: "", manifest: true, systemPrompt: "Safety test", origin: "user", kind: "behavioral", filePath: join(root, "agent.md"), rootDir: root, resumable: false };
			const ctx = { cwd: root, isProjectTrusted: () => scenario !== "trust-denied", sessionManager: { getBranch: () => [] }, model: { provider: "caller", id: "default" }, modelRegistry: { getAvailable: () => [{ provider: "provider", id: "explicit" }] } };
			if (scenario === "already-aborted") controller.abort();
			const result = await runDelegation({ appendEntry() {} }, ctx, root, [agent], local ? root : agent.id, "new", "Safety test", controller.signal, () => {
				if (scenario.startsWith("abort-")) controller.abort();
			}, details, false);
			const launches = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map(JSON.parse) : [];
			if (scenario === "trust-denied") assert.ok(launches[0].includes("--no-approve"));
			else if (scenario === "trust-allowed") assert.ok(!launches[0].includes("--no-approve") && !launches[0].includes("--approve"));
			else {
				assert.equal(result.stopReason, "aborted");
				assert.match(result.errorMessage, /aborted/);
				assert.notEqual(result.exitCode, 0);
				assert.equal(spawnCount, scenario === "already-aborted" ? 0 : 1);
				assert.equal(launches.length, scenario === "already-aborted" ? 0 : 1);
			}
			for (const args of launches) {
				const prompt = args[args.indexOf("--append-system-prompt") + 1];
				assert.equal(existsSync(prompt), false, "temporary prompt removed after close");
			}
		} finally {
			controller.abort();
			childProcess.spawn = originalSpawn;
			syncBuiltinESMExports();
			restorePi();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("aborted pre-work calls never qualify for provider fallback or context-limit reclassification", () => {
	assert.equal(shouldRetryPreferredModelFailure({ exitCode: 130, stopReason: "aborted", stderr: "provider unavailable", messages: [] }), false);
	const result = { exitCode: 130, stopReason: "aborted", stderr: "context_length_exceeded", messages: [] };
	assert.equal(classifyContextLimitFailure(result), false);
	assert.equal(result.stopReason, "aborted");
});
