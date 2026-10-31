import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { THINKING_LEVELS, discoverAgents, isPathInside, loadLocationalAgent, resolveLocationalAgentId, scanLocationalAgents } from "../agents.ts";
import { getGuardedLocationalRoots } from "../locational-guard.ts";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pi-subagent-agents-test-"));
}

test("loadLocationalAgent parses frontmatter, defaults, and same-root @includes", () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "extra.md"), "included body");
		writeFileSync(join(root, "SUBAGENTS.md"), "---\ndescription: Test\ntools: read, bash\nthinking: high\nmanifest: false\nresumable: no\n---\n@extra.md\n");
		const { agent, error } = loadLocationalAgent(root, { readBody: true });
		assert.equal(error, undefined);
		assert.equal(agent.description, "Test");
		assert.deepEqual(agent.tools, ["read", "bash"]);
		assert.equal(agent.thinking, "high");
		assert.equal(agent.manifest, false);
		assert.equal(agent.resumable, false);
		assert.equal(agent.systemPrompt, "included body");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("agent definitions validate thinking for locational and behavioral agents", () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "SUBAGENTS.md"), "---\nthinking: deepest\n---\n");
		const locational = loadLocationalAgent(root, { readBody: true });
		assert.equal(locational.agent, undefined);
		assert.match(locational.error, /unsupported thinking level "deepest"/);

		const behavioralRoot = join(root, ".pi", "agents", "thinker");
		mkdirSync(behavioralRoot, { recursive: true });
		writeFileSync(join(behavioralRoot, "SUBAGENTS.md"), "---\nthinking: deepest\n---\n");
		const behavioral = discoverAgents(root, true, { includeLocationalAgents: false });
		assert.equal(behavioral.agents.some((agent) => agent.id === "thinker"), false);
		assert.match(behavioral.errors.join("\n"), /unsupported thinking level "deepest"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("behavioral caller overrides require a complete, valid flat rule", () => {
	const root = tempDir();
	const agentDir = tempDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const definition = join(root, ".pi", "agents", "conditional", "SUBAGENTS.md");
		mkdirSync(join(root, ".pi", "agents", "conditional"), { recursive: true });
		const fields = ["whenCallerModelId: gpt-6-astra", "thenModel: caller", "thenThinking: low"];
		for (const thinking of THINKING_LEVELS) {
			writeFileSync(definition, `---\n${fields.slice(0, 2).join("\n")}\nthenThinking: ${thinking}\n---\n`);
			const discovery = discoverAgents(root, true, { includeLocationalAgents: false });
			assert.deepEqual(discovery.errors, []);
			const conditional = discovery.agents.find((agent) => agent.id === "conditional");
			assert.equal(conditional.whenCallerModelId, "gpt-6-astra");
			assert.equal(conditional.thenModel, "caller");
			assert.equal(conditional.thenThinking, thinking);
			assert.equal(conditional.thinking, undefined);
		}
		for (const [value, expected] of [
			["gpt-6-astra", "gpt-6-astra"],
			["[gpt-6-astra]", ["gpt-6-astra"]],
			['["gpt-6-astra", "gpt-6.1-sol"]', ["gpt-6-astra", "gpt-6.1-sol"]],
			['\n  - gpt-6-astra\n  - "gpt-6.1-sol"', ["gpt-6-astra", "gpt-6.1-sol"]],
			["[vendor/model, OTHER]", ["vendor/model", "OTHER"]],
		]) {
			for (const target of ["caller", "openai/gpt-6.1-sol", "openai/gpt-6-astra", "provider/vendor/model"]) {
				writeFileSync(definition, `---\nwhenCallerModelId: ${value}\nthenModel: ${target}\nthenThinking: low\n---\n`);
				const discovery = discoverAgents(root, true, { includeLocationalAgents: false });
				assert.deepEqual(discovery.errors, []);
				const conditional = discovery.agents.find((agent) => agent.id === "conditional");
				assert.deepEqual(conditional.whenCallerModelId, expected);
				assert.equal(conditional.thenModel, target);
			}
		}
		const invalid = [];
		for (let mask = 1; mask < 7; mask++) {
			invalid.push([fields.filter((_field, index) => mask & (1 << index)).join("\n"), /require .* together/]);
		}
		for (const value of ["", '""', "true", "[]", '[gpt-6-astra, ""]', "[gpt-6-astra, gpt-*]", '[gpt-6-astra, " gpt-6.1-sol"]', "[[gpt-6-astra]]", "\n  - gpt-6-astra\n  - false", "gpt-6-astra,other", "gpt-*", "gpt-?", '" gpt-6-astra"', '"gpt 6"']) {
			invalid.push([`whenCallerModelId: ${value}\n${fields.slice(1).join("\n")}`, /whenCallerModelId must be an exact model ID or a nonempty list/]);
		}
		for (const value of ["", "true", "[caller]", "inherit", "gpt-6.1-sol", "[openai/gpt-6.1-sol]", "openai/", "/gpt-6.1-sol", "openai/gpt-*", "openai/gpt-?", "openai/gpt-6-astra,openai/gpt-6.1-sol", '" openai/gpt-6.1-sol"', '"openai/gpt 6"']) {
			invalid.push([`${fields[0]}\nthenModel: ${value}\n${fields[2]}`, /thenModel must be "caller"/]);
		}
		for (const value of ["", "false", "[low]", "deepest", "LOW"]) {
			invalid.push([`${fields.slice(0, 2).join("\n")}\nthenThinking: ${value}`, /unsupported thenThinking level/]);
		}
		invalid.push([`${fields.join("\n")}\nthenTools: bash`, /unsupported frontmatter/]);
		for (const [body, error] of invalid) {
			writeFileSync(definition, `---\n${body}\n---\n`);
			const discovery = discoverAgents(root, true, { includeLocationalAgents: false });
			assert.equal(discovery.agents.some((agent) => agent.id === "conditional"), false, body);
			assert.match(discovery.errors.join("\n"), error, body);
		}
		for (const body of [...fields, fields.join("\n"), "whenCallerModelId: [gpt-6-astra, gpt-6.1-sol]\nthenModel: openai/gpt-6.1-sol\nthenThinking: low"]) {
			writeFileSync(join(root, "SUBAGENTS.md"), `---\n${body}\n---\n`);
			const locational = loadLocationalAgent(root);
			assert.equal(locational.agent, undefined);
			assert.match(locational.error, /only for behavioral agents/);
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("loadLocationalAgent accepts every supported thinking level", () => {
	const root = tempDir();
	try {
		for (const thinking of THINKING_LEVELS) {
			writeFileSync(join(root, "SUBAGENTS.md"), `---\nthinking: ${thinking}\n---\n`);
			const { agent, error } = loadLocationalAgent(root, { readBody: true });
			assert.equal(error, undefined);
			assert.equal(agent.thinking, thinking);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadLocationalAgent reports unsupported frontmatter", () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "SUBAGENTS.md"), "---\nunknown: value\n---\nBody\n");
		const { agent, error } = loadLocationalAgent(root, { readBody: true });
		assert.equal(agent, undefined);
		assert.match(error, /unsupported frontmatter/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scanLocationalAgents finds nested roots, skips node_modules, and resolves ids", () => {
	const root = tempDir();
	try {
		const owned = join(root, "owned");
		const skipped = join(root, "node_modules", "owned");
		mkdirSync(owned, { recursive: true });
		mkdirSync(skipped, { recursive: true });
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owned\n---\nBody\n");
		writeFileSync(join(skipped, "SUBAGENTS.md"), "---\ndescription: Skipped\n---\nBody\n");

		const scan = scanLocationalAgents(root, { maxDepth: 4, timeoutMs: 1000 });
		assert.deepEqual(scan.agents.map((agent) => realpathSync.native(agent.rootDir)), [realpathSync.native(owned)]);
		assert.equal(realpathSync.native(resolveLocationalAgentId(root, "owned").rootDir), realpathSync.native(owned));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("CWD portable project behavioral definitions load only when trusted", () => {
	const root = tempDir();
	try {
		const portable = join(root, ".agents", "subagents", "portable");
		mkdirSync(portable, { recursive: true });
		writeFileSync(join(portable, "SUBAGENTS.md"), "---\ndescription: Portable project\n---\n");
		const trusted = discoverAgents(root, true, { includeLocationalAgents: false });
		assert.equal(trusted.projectAgentsDir, join(root, ".agents", "subagents"));
		assert.equal(trusted.agents.find((agent) => agent.id === "portable").description, "Portable project");
		const untrusted = discoverAgents(root, false, { includeLocationalAgents: false });
		assert.equal(untrusted.projectAgentsDir, null);
		assert.equal(untrusted.agents.some((agent) => agent.id === "portable"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("project behavioral discovery does not walk ancestors", () => {
	const legacyRoot = tempDir();
	const portableRoot = tempDir();
	try {
		const legacyCwd = join(legacyRoot, "child");
		const portableCwd = join(portableRoot, "child");
		mkdirSync(legacyCwd);
		mkdirSync(portableCwd);
		mkdirSync(join(legacyRoot, ".pi", "agents", "ancestor"), { recursive: true });
		mkdirSync(join(portableRoot, ".agents", "subagents", "ancestor"), { recursive: true });
		writeFileSync(join(legacyRoot, ".pi", "agents", "ancestor", "SUBAGENTS.md"), "---\ndescription: Ancestor legacy\n---\n");
		writeFileSync(join(portableRoot, ".agents", "subagents", "ancestor", "SUBAGENTS.md"), "---\ndescription: Ancestor portable\n---\n");
		assert.equal(discoverAgents(legacyCwd, true, { includeLocationalAgents: false }).projectAgentsDir, null);
		assert.equal(discoverAgents(portableCwd, true, { includeLocationalAgents: false }).projectAgentsDir, null);
		assert.equal(discoverAgents(legacyCwd, true, { includeLocationalAgents: false }).agents.some((agent) => agent.id === "ancestor"), false);
		assert.equal(discoverAgents(portableCwd, true, { includeLocationalAgents: false }).agents.some((agent) => agent.id === "ancestor"), false);
	} finally {
		rmSync(legacyRoot, { recursive: true, force: true });
		rmSync(portableRoot, { recursive: true, force: true });
	}
});

test("portable project definitions preserve bundled and user precedence", () => {
	const root = tempDir();
	const agentDir = tempDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		mkdirSync(join(agentDir, "agents", "scout"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "scout", "SUBAGENTS.md"), "---\ndescription: User scout\n---\n");
		mkdirSync(join(root, ".agents", "subagents", "scout"), { recursive: true });
		writeFileSync(join(root, ".agents", "subagents", "scout", "SUBAGENTS.md"), "---\ndescription: Portable scout\n---\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		assert.equal(discoverAgents(root, false, { includeLocationalAgents: false }).agents.find((agent) => agent.id === "scout").description, "User scout");
		const trusted = discoverAgents(root, true, { includeLocationalAgents: false });
		assert.equal(trusted.agents.find((agent) => agent.id === "scout").description, "Portable scout");
		assert.equal(trusted.agents.find((agent) => agent.id === "scout").overrides, true);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("CWD .pi project behavioral definitions are selected", () => {
	const root = tempDir();
	try {
		const legacy = join(root, ".pi", "agents", "legacy");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "SUBAGENTS.md"), "---\ndescription: Legacy project\n---\n");
		const discovery = discoverAgents(root, true, { includeLocationalAgents: false });
		assert.equal(discovery.projectAgentsDir, join(root, ".pi", "agents"));
		assert.equal(discovery.agents.find((agent) => agent.id === "legacy").description, "Legacy project");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an empty CWD .pi project directory masks portable definitions", () => {
	const root = tempDir();
	try {
		const portable = join(root, ".agents", "subagents", "portable");
		mkdirSync(portable, { recursive: true });
		writeFileSync(join(portable, "SUBAGENTS.md"), "---\ndescription: Portable project\n---\n");
		mkdirSync(join(root, ".pi", "agents"), { recursive: true });
		const discovery = discoverAgents(root, true, { includeLocationalAgents: false });
		assert.equal(discovery.projectAgentsDir, join(root, ".pi", "agents"));
		assert.equal(discovery.agents.some((agent) => agent.id === "portable"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("only the CWD portable tree is excluded from locational discovery, IDs, and guards", () => {
	const root = tempDir();
	try {
		const portable = join(root, ".agents", "subagents", "portable");
		const nested = join(root, "nested", ".agents", "subagents", "nested");
		const owned = join(root, "owned");
		mkdirSync(portable, { recursive: true });
		mkdirSync(nested, { recursive: true });
		mkdirSync(owned);
		writeFileSync(join(portable, "SUBAGENTS.md"), "---\ndescription: Portable project\n---\n");
		writeFileSync(join(nested, "SUBAGENTS.md"), "---\ndescription: Nested locational\n---\n");
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owned\n---\n");
		const expected = [realpathSync.native(nested), realpathSync.native(owned)].sort();
		assert.deepEqual(scanLocationalAgents(root).agents.map((agent) => realpathSync.native(agent.rootDir)).sort(), expected);
		assert.equal(resolveLocationalAgentId(root, ".agents/subagents/portable"), null);
		assert.equal(realpathSync.native(resolveLocationalAgentId(root, "nested/.agents/subagents/nested").rootDir), realpathSync.native(nested));
		assert.deepEqual(getGuardedLocationalRoots(root).sort(), expected);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("behavioral discovery precedence is bundled, user, then trusted project", () => {
	const root = tempDir();
	const agentDir = tempDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		mkdirSync(join(agentDir, "agents", "scout"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "scout", "SUBAGENTS.md"), "---\ndescription: User scout\nwhenCallerModelId: user-model\nthenModel: caller\nthenThinking: off\n---\nUser\n");
		mkdirSync(join(root, ".pi", "agents", "scout"), { recursive: true });
		writeFileSync(join(root, ".pi", "agents", "scout", "SUBAGENTS.md"), "---\ndescription: Project scout\nthinking: medium\n---\nProject\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const untrusted = discoverAgents(root, false, { includeLocationalAgents: false });
		assert.equal(untrusted.agents.find((agent) => agent.id === "scout").description, "User scout");
		assert.equal(untrusted.agents.find((agent) => agent.id === "scout").overrides, true);
		assert.equal(untrusted.agents.find((agent) => agent.id === "scout").whenCallerModelId, "user-model");
		assert.equal(untrusted.agents.find((agent) => agent.id === "scout").thenThinking, "off");
		assert.equal(untrusted.projectAgentsDir, null);

		const trusted = discoverAgents(root, true, { includeLocationalAgents: false });
		assert.equal(trusted.agents.find((agent) => agent.id === "scout").description, "Project scout");
		assert.equal(trusted.agents.find((agent) => agent.id === "scout").thinking, "medium");
		assert.equal(trusted.agents.find((agent) => agent.id === "scout").whenCallerModelId, undefined);
		assert.equal(trusted.agents.find((agent) => agent.id === "scout").thenModel, undefined);
		assert.equal(trusted.agents.find((agent) => agent.id === "scout").thenThinking, undefined);
		assert.equal(trusted.agents.find((agent) => agent.id === "scout").overrides, true);
		assert.equal(trusted.projectAgentsDir, join(root, ".pi", "agents"));
		assert.deepEqual(trusted.agents.map((agent) => agent.id).sort(), ["reviewer", "scout", "worker"]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("custom behavioral and ordinary locational definitions are not overrides", () => {
	const root = tempDir();
	const agentDir = tempDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		mkdirSync(join(agentDir, "agents", "custom-user"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "custom-user", "SUBAGENTS.md"), "---\ndescription: Custom user\n---\n");
		mkdirSync(join(root, ".pi", "agents", "custom-project"), { recursive: true });
		writeFileSync(join(root, ".pi", "agents", "custom-project", "SUBAGENTS.md"), "---\ndescription: Custom project\n---\n");
		const owned = join(root, "owned");
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owned\n---\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const discovered = discoverAgents(root, true);
		assert.equal(discovered.agents.find((agent) => agent.id === "custom-user").overrides, false);
		assert.equal(discovered.agents.find((agent) => agent.id === "custom-project").overrides, false);
		assert.notEqual(discovered.locationalAgents.find((agent) => agent.id === owned).overrides, true);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("locational discovery requires project trust", () => {
	const root = tempDir();
	try {
		const owned = join(root, "owned");
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owned\n---\nBody\n");
		assert.equal(discoverAgents(root, false).locationalAgents.length, 0);
		assert.equal(discoverAgents(root, true).locationalAgents[0].rootDir, owned);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isPathInside includes root and descendants but excludes siblings", () => {
	const root = tempDir();
	const sibling = `${root}-sibling`;
	try {
		mkdirSync(join(root, "child"));
		mkdirSync(sibling);
		assert.equal(isPathInside(root, root), true);
		assert.equal(isPathInside(join(root, "child"), root), true);
		assert.equal(isPathInside(sibling, root), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(sibling, { recursive: true, force: true });
	}
});
