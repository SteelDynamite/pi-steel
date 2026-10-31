import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isBehavioralDefinitionPath, isPathInside, scanLocationalAgents } from "../agents.ts";
import subagentExtension from "../index.ts";
import { CURRENT_LOCATIONAL_ROOT_ENV } from "../constants.ts";

function guard() {
	let handler;
	subagentExtension({ on(name, fn) { if (name === "tool_call") handler = fn; }, registerCommand() {}, registerTool() {}, registerEntryRenderer() {} });
	return handler;
}

for (const scenario of ["dotdot-name", "invalid-metadata", "bare-new-file"]) {
	test(`source boundary blocks ${scenario}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-source-boundary-"));
		try {
			const owned = join(root, "owned space");
			mkdirSync(owned);
			writeFileSync(join(owned, "SUBAGENTS.md"), scenario === "invalid-metadata" ? "---\nthinking: invalid\n---\n" : "Owner\n");
			let target = join(owned, scenario === "dotdot-name" ? "..notes" : "new.txt");
			if (scenario === "dotdot-name") assert.equal(isPathInside(target, owned), true);
			if (scenario === "invalid-metadata") {
				const scan = scanLocationalAgents(root);
				assert.equal(scan.agents.length, 0);
				assert.equal(scan.errors.length, 1);
				assert.deepEqual(scan.roots, [owned]);
			}
			const cwd = scenario === "bare-new-file" ? owned : root;
			if (scenario === "bare-new-file") target = "new.txt";
			assert.equal((await guard()({ toolName: "write", input: { path: target, content: "x" } }, { cwd, hasUI: false }))?.block, true);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
}

test("active owners and behavioral exclusions survive invalid metadata", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-source-controls-"));
	const previous = process.env[CURRENT_LOCATIONAL_ROOT_ENV];
	try {
		const behavioral = join(root, ".agents", "subagents", "..worker");
		mkdirSync(behavioral, { recursive: true });
		writeFileSync(join(behavioral, "SUBAGENTS.md"), "---\nthinking: invalid\n---\n");
		assert.equal(isBehavioralDefinitionPath(behavioral, [join(root, ".agents", "subagents")]), true);
		assert.deepEqual(scanLocationalAgents(root).roots, []);
		const check = guard();
		const ctx = { cwd: root, hasUI: false };
		const event = { toolName: "write", input: { path: join(behavioral, "missing", "..notes") } };
		assert.equal(await check(event, ctx), undefined);
		writeFileSync(join(root, "SUBAGENTS.md"), "Real owner\n");
		assert.equal((await check(event, ctx))?.block, true);
		process.env[CURRENT_LOCATIONAL_ROOT_ENV] = root;
		assert.equal(await check(event, ctx), undefined);
	} finally {
		if (previous === undefined) delete process.env[CURRENT_LOCATIONAL_ROOT_ENV];
		else process.env[CURRENT_LOCATIONAL_ROOT_ENV] = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("path containment rejects parents, sibling prefixes and existing symlink escapes", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-source-containment-"));
	try {
		mkdirSync(join(root, "owned"));
		mkdirSync(join(root, "other"));
		symlinkSync(join(root, "other"), join(root, "owned", "escape"), "dir");
		assert.equal(isPathInside(root, join(root, "owned")), false);
		assert.equal(isPathInside(join(root, "owned-other", "new.txt"), join(root, "owned")), false);
		assert.equal(isPathInside(join(root, "owned", "escape"), join(root, "owned")), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
