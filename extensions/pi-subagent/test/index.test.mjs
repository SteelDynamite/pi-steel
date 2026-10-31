import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import subagentExtension from "../index.ts";
import { SubagentParams } from "../schema.ts";

function registerExtension() {
	const handlers = new Map();
	const commands = new Map();
	const tools = [];
	const pi = {
		on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand(name, command) { commands.set(name, command); },
		registerTool(tool) { tools.push(tool); },
		registerEntryRenderer() {},
		appendEntry() {},
	};
	subagentExtension(pi);
	return { pi, handlers, commands, tools };
}

test("extension registers singular settings and the public subagent tool", () => {
	const { commands, tools } = registerExtension();
	assert.deepEqual(tools.map((tool) => tool.name), ["subagent"]);
	assert.equal(tools[0].label, "Subagent");
	assert.equal(tools[0].exposure, "model-only");
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	assert.match(tools[0].renderCall({ id: "scout", session: "new", task: "inspect" }, theme, {}).render(120).join("\n"), /^subagent scout/);
	assert.deepEqual([...commands.keys()], ["subagent-settings"]);
	assert.deepEqual(Object.keys(SubagentParams.properties).sort(), ["contextDocs", "id", "includeLocationalAgents", "session", "task"]);
	assert.deepEqual([...SubagentParams.required].sort(), ["id", "session", "task"]);
	assert.equal(SubagentParams.additionalProperties, false);
	for (const removed of ["commands", "tasks", "chain", "cwd", "handoffDocs", "agentScope", "confirmProjectAgents"]) {
		assert.equal(SubagentParams.properties[removed], undefined);
	}
});

test("built-in bash path arguments remain subject to locational boundaries", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-boundary-"));
	try {
		const owned = join(root, "owned");
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owns boundary tests.\n---\nBody\n");
		const { handlers } = registerExtension();
		const result = await handlers.get("tool_call")[0]({
			toolName: "bash",
			input: { command: "cat owned/secret.txt" },
		}, {
			cwd: root,
			hasUI: false,
		});
		assert.equal(result.block, true);
		assert.match(result.reason, /delegate with subagent using locational agent/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("untrusted projects cannot invoke locational agents", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-untrusted-call-"));
	try {
		const owned = join(root, "owned");
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owns tests.\n---\nBody\n");
		const { tools } = registerExtension();
		const result = await tools[0].execute("call", { id: "owned", session: "new", task: "work" }, undefined, undefined, {
			cwd: root,
			isProjectTrusted: () => false,
			hasUI: false,
			mode: "json",
			ui: {},
			sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
			modelRegistry: { getAvailable: () => [] },
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /not trusted/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
