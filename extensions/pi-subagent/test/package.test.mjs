import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("package exports no prompt templates and retains behavioral delegation", () => {
	const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
	assert.equal(manifest.name, "pi-subagent");
	assert.deepEqual(manifest.pi.prompts, []);
	assert.deepEqual(manifest.pi.skills, [], "Herdr skill is only exposed dynamically by its owner");
	assert(existsSync(new URL("skills/herdr-delegation/SKILL.md", root)));
	assert.equal(existsSync(new URL("prompts/", root)), false);
	assert.deepEqual(readdirSync(new URL("agents/", root)).sort(), ["reviewer", "scout", "worker"]);

	const source = readFileSync(new URL("index.ts", root), "utf8");
	assert.doesNotMatch(source, /name: ["'](?:subprocess|subagents)["']|registerCommand\(["'](?:subprocess|subagents)-settings/);
	assert.doesNotMatch(source, /handoffDocs|agentScope|confirmProjectAgents/);

	const extensionSource = readdirSync(root)
		.filter((file) => file.endsWith(".ts"))
		.map((file) => readFileSync(new URL(file, root), "utf8"))
		.join("\n");
	assert.doesNotMatch(extensionSource, /pi-subagents|PI_SUBAGENTS|["']subagents-(?:settings|state)["']/);
	assert.match(extensionSource, /name: "subagent"/);
});
