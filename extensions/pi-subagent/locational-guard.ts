import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import { getAgentInstructionsFileName, getBehavioralDefinitionRoots, isBehavioralDefinitionPath, scanLocationalAgents } from "./agents.ts";
import { CURRENT_LOCATIONAL_ROOT_ENV, LOCATIONAL_ANCESTOR_STACK_ENV } from "./constants.ts";
import type { ExtensionContext } from "./pi-compat.ts";

const notifiedLocationalBoundaryKeys = new Set<string>();

export function notifyLocationalBoundaryDiscovered(ctx: ExtensionContext, root: string): void {
	if (!ctx.hasUI) return;
	const key = `${path.resolve(ctx.cwd)}\0${path.resolve(root)}`;
	if (notifiedLocationalBoundaryKeys.has(key)) return;
	notifiedLocationalBoundaryKeys.add(key);
	ctx.ui.notify(`Locational boundary discovered: delegate with subagent using locational agent id "${root}"`, "info");
}

export function canonicalPath(value: string): string {
	try {
		return fs.realpathSync.native(path.resolve(value));
	} catch {
		return path.resolve(value);
	}
}

function environmentRoot(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? canonicalPath(value) : undefined;
}

export function getLocationalAncestorStack(): string[] {
	const raw = process.env[LOCATIONAL_ANCESTOR_STACK_ENV]?.trim();
	const roots: string[] = [];
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) roots.push(...parsed.filter((item): item is string => typeof item === "string"));
		} catch {
			roots.push(...raw.split(path.delimiter).filter(Boolean));
		}
	}
	const current = environmentRoot(CURRENT_LOCATIONAL_ROOT_ENV);
	if (current) roots.push(current);
	return [...new Set(roots.map(canonicalPath))];
}

export function getLocationalLoopError(agent: AgentConfig): string | undefined {
	if (agent.kind !== "locational") return undefined;
	const target = canonicalPath(agent.rootDir);
	const matching = getLocationalAncestorStack().find((root) => root === target);
	if (!matching) return undefined;
	const stack = [...getLocationalAncestorStack(), target].join(" -> ");
	return `Locational delegation loop blocked: locational agent "${agent.id}" resolves to "${target}", which is already active as "${matching}".${stack ? ` Stack: ${stack}.` : ""}`;
}

function containingLocationalRoot(cwd: string): string | undefined {
	const behavioralRoots = getBehavioralDefinitionRoots(cwd);
	for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
		if (!isBehavioralDefinitionPath(current, behavioralRoots) && fs.existsSync(path.join(current, getAgentInstructionsFileName()))) return canonicalPath(current);
		if (path.dirname(current) === current) return undefined;
	}
}

export function getGuardedLocationalRoots(cwd: string): string[] {
	const active = environmentRoot(CURRENT_LOCATIONAL_ROOT_ENV);
	const roots = scanLocationalAgents(cwd).roots.map(canonicalPath);
	const containing = containingLocationalRoot(cwd);
	if (containing) roots.push(containing);
	return [...new Set(roots)].filter((root) => root !== active);
}

export function makeChildLocationalEnv(agent: AgentConfig): Record<string, string> {
	if (agent.kind !== "locational") return {};
	const target = canonicalPath(agent.rootDir);
	return {
		[CURRENT_LOCATIONAL_ROOT_ENV]: target,
		[LOCATIONAL_ANCESTOR_STACK_ENV]: JSON.stringify([...new Set([...getLocationalAncestorStack(), target])]),
	};
}

export function resolveFilesystemTarget(cwd: string, value: string, options: { allowBare?: boolean } = {}): string | null {
	const trimmed = value.trim();
	if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^git:[^/]/i.test(trimmed)) return null;
	const isPath = path.isAbsolute(trimmed)
		|| trimmed.startsWith("./")
		|| trimmed.startsWith("../")
		|| trimmed === "."
		|| trimmed === ".."
		|| trimmed.startsWith("~/")
		|| /[\\/]/.test(trimmed)
		|| Boolean(options.allowBare);
	if (!isPath) return null;
	const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
	return canonicalPath(path.resolve(cwd, expanded));
}

function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "\"" | "'" | null = null;
	let escaped = false;
	for (const character of command) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if ((character === "\"" || character === "'") && !quote) {
			quote = character;
			continue;
		}
		if (character === quote) {
			quote = null;
			continue;
		}
		if (!quote && /\s/.test(character)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** Extracts explicit path-like shell arguments; dynamic and recursive shell access is not sandboxed. */
export function commandFilesystemTargets(command: string, cwd: string): string[] {
	const tokens = shellTokens(command);
	const targets: string[] = [];
	const optionsWithPaths = new Set(["-C", "--cwd", "--prefix", "--dir", "--directory", "--chdir", "--path", "--work-tree", "--git-dir"]);
	const commandsWithPathArguments = new Set(["cd", "pushd", "popd", "ls", "cat", "stat", "tail", "head", "less", "more", "realpath", "readlink"]);
	const add = (value: string, allowBare = false) => {
		const target = resolveFilesystemTarget(cwd, value, { allowBare });
		if (target) targets.push(target);
	};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (commandsWithPathArguments.has(path.basename(token)) && tokens[index + 1]) add(tokens[index + 1], true);
		if (optionsWithPaths.has(token) && tokens[index + 1]) {
			add(tokens[index + 1], true);
			continue;
		}
		const option = token.match(/^(--(?:cwd|prefix|dir|directory|chdir|path|work-tree|git-dir))=(.+)$/);
		if (option) {
			add(option[2], true);
			continue;
		}
		add(token);
	}
	return targets;
}
