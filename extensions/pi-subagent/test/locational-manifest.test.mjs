import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ADVERTISE_LOCATIONAL_AGENTS_ENV, ORCHESTRATED_CHILD_ENV } from "../constants.ts";
import subagentExtension from "../index.ts";
import {
	LOCATIONAL_MANIFEST_ENTRY,
	appendLocationalManifest,
	makeLocationalManifest,
	renderLocationalManifest,
} from "../locational-manifest.ts";
import { formatBehavioralAgentManifest } from "../prompt.ts";

function agent(rootDir, overrides = {}) {
	return {
		id: rootDir,
		description: "Owns this source.",
		manifest: true,
		systemPrompt: "",
		origin: "locational",
		kind: "locational",
		filePath: join(rootDir, "SUBAGENTS.md"),
		rootDir,
		resumable: true,
		...overrides,
	};
}

async function withCleanManifestEnv(fn) {
	const keys = [ADVERTISE_LOCATIONAL_AGENTS_ENV, ORCHESTRATED_CHILD_ENV, "PI_CODING_AGENT_DIR"];
	const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	try {
		return await fn();
	} finally {
		for (const key of keys) {
			if (original[key] === undefined) delete process.env[key];
			else process.env[key] = original[key];
		}
	}
}

test("locational manifest uses the singular extension state identifier and visible canonical records", () => {
	assert.equal(LOCATIONAL_MANIFEST_ENTRY, "pi-subagent-locational-manifest");
	const cwd = resolve("/project");
	const manifest = makeLocationalManifest([
		agent(join(cwd, "packages", "owned")),
		agent(join(cwd, "packages", "other"), { description: "Owns other source." }),
		agent(join(cwd, "hidden"), { manifest: false }),
		agent(join(cwd, "behavioral"), { id: "worker", kind: "behavioral", origin: "user" }),
	]);
	assert.deepEqual(manifest, {
		content: `## Available locational agents

Each path below is both a locational agent's source root and full \`subagent\` id. Work inside listed roots must be delegated to the corresponding agent rather than accessed directly.

- \`/project/packages/owned\`: Owns this source.
- \`/project/packages/other\`: Owns other source.`,
	});
});

test("behavioral manifest excludes locational agents", () => {
	const behavioral = agent("/project/worker", { id: "worker", kind: "behavioral", origin: "user", description: "General work." });
	assert.equal(formatBehavioralAgentManifest([behavioral, agent("/project/owned")]), `<available-behavioral-subagents>
  <agent>
    <id>worker</id>
    <description>General work.</description>
  </agent>
</available-behavioral-subagents>`);
});

test("TUI manifest is trusted, durable, and deduplicated on the active branch", () => withCleanManifestEnv(() => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-manifest-"));
	try {
		const owned = join(root, "owned");
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owns the service.\n---\nBody\n");
		process.env.PI_CODING_AGENT_DIR = join(root, "empty-agent-dir");
		let visibleEntries = [];
		const appended = [];
		const pi = {
			appendEntry(customType, data) {
				const entry = { type: "custom", customType, data };
				appended.push(entry);
				visibleEntries.push(entry);
			},
		};
		const ctx = {
			mode: "tui",
			cwd: root,
			isProjectTrusted: () => true,
			sessionManager: { getBranch: () => visibleEntries, buildContextEntries: () => visibleEntries },
		};
		assert.equal(appendLocationalManifest(pi, ctx), true);
		assert.equal(appended[0].customType, LOCATIONAL_MANIFEST_ENTRY);
		assert.equal(appended[0].data.content.includes(`- \`${owned}\`: Owns the service.`), true);
		assert.equal(appendLocationalManifest(pi, ctx), false);
		visibleEntries = [];
		assert.equal(appendLocationalManifest(pi, ctx), true);
		assert.equal(appended.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}));

test("extension lifecycle keeps model and TUI manifests identical", () => withCleanManifestEnv(async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-lifecycle-"));
	try {
		const owned = join(root, "owned");
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owns lifecycle tests.\n---\nBody\n");
		process.env.PI_CODING_AGENT_DIR = join(root, "empty-agent-dir");
		const handlers = new Map();
		const renderedTypes = [];
		const appended = [];
		let visibleEntries = [];
		const pi = {
			on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			registerCommand() {},
			registerTool() {},
			registerEntryRenderer(customType) { renderedTypes.push(customType); },
			appendEntry(customType, data) {
				const entry = { type: "custom", customType, data };
				appended.push(entry);
				visibleEntries.push(entry);
			},
		};
		subagentExtension(pi);
		const ctx = {
			mode: "tui",
			cwd: root,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: {},
			sessionManager: { getBranch: () => visibleEntries, buildContextEntries: () => visibleEntries },
		};
		assert.deepEqual(renderedTypes, [LOCATIONAL_MANIFEST_ENTRY]);
		await handlers.get("session_start")[0]({ reason: "startup" }, ctx);
		await handlers.get("session_start")[0]({ reason: "reload" }, ctx);
		assert.equal(appended.length, 1);
		const prompt = await handlers.get("before_agent_start")[0]({
			systemPrompt: "base",
			systemPromptOptions: { contextFiles: [], selectedTools: [], toolSnippets: {} },
		}, ctx);
		assert.equal(prompt.systemPrompt.endsWith(appended[0].data.content), true);
		visibleEntries = [];
		await handlers.get("session_tree")[0]({}, ctx);
		visibleEntries = [];
		await handlers.get("session_compact")[0]({}, ctx);
		assert.equal(appended.length, 3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}));

test("manifest is suppressed outside trusted parent TUI sessions", () => withCleanManifestEnv(() => {
	let calls = 0;
	const pi = { appendEntry: () => calls++ };
	const ctx = {
		mode: "rpc",
		cwd: "/tmp/project",
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
	};
	assert.equal(appendLocationalManifest(pi, ctx), false);
	ctx.mode = "tui";
	ctx.isProjectTrusted = () => false;
	assert.equal(appendLocationalManifest(pi, ctx), false);
	ctx.isProjectTrusted = () => true;
	process.env[ORCHESTRATED_CHILD_ENV] = "1";
	assert.equal(appendLocationalManifest(pi, ctx), false);
	process.env[ORCHESTRATED_CHILD_ENV] = "0";
	process.env[ADVERTISE_LOCATIONAL_AGENTS_ENV] = "0";
	assert.equal(appendLocationalManifest(pi, ctx), false);
	assert.equal(calls, 0);
}));

test("untrusted model prompts do not advertise locational roots", () => withCleanManifestEnv(async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-untrusted-"));
	try {
		const owned = join(root, "owned");
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Secret route.\n---\nBody\n");
		process.env.PI_CODING_AGENT_DIR = join(root, "empty-agent-dir");
		const handlers = new Map();
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand() {}, registerTool() {}, registerEntryRenderer() {}, appendEntry() {},
		};
		subagentExtension(pi);
		const prompt = await handlers.get("before_agent_start")({
			systemPrompt: "base",
			systemPromptOptions: { contextFiles: [], selectedTools: [], toolSnippets: {} },
		}, {
			cwd: root,
			isProjectTrusted: () => false,
		});
		assert.doesNotMatch(prompt.systemPrompt, /Secret route|Available locational agents/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}));

test("manifest renderer has identical collapsed and expanded content", () => {
	const foregrounds = [];
	const backgrounds = [];
	const style = (text) => text;
	const theme = {
		bold: style, italic: style, underline: style, strikethrough: style,
		fg(color, text) { foregrounds.push(color); return text; },
		bg(color, text) { backgrounds.push(color); return text; },
	};
	const entry = { data: makeLocationalManifest([agent("/project/owned", { description: "Owns it." })]) };
	const collapsed = renderLocationalManifest(entry, { expanded: false }, theme).render(120).join("\n");
	const expanded = renderLocationalManifest(entry, { expanded: true }, theme).render(120).join("\n");
	assert.equal(expanded, collapsed);
	assert.match(collapsed, /Available locational agents/);
	assert.match(collapsed, /full subagent id/);
	assert.match(collapsed, /- \/project\/owned: Owns it\./);
	assert.ok(foregrounds.includes("customMessageText"));
	assert.ok(backgrounds.every((color) => color === "customMessageBg"));
});
