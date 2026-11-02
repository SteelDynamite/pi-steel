import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./agents.ts";
import { getAgentInstructionsFileName, getBehavioralDefinitionRoots, isBehavioralDefinitionPath, scanLocationalAgents, realPathIfExists } from "./agents.ts";
import { CURRENT_LOCATIONAL_ROOT_ENV, LOCATIONAL_ANCESTOR_STACK_ENV, locationalAgentsEnabled } from "./constants.ts";
import type { ExtensionContext } from "./pi-compat.ts";

const notifiedLocationalBoundaryKeys = new Set<string>();

export function notifyLocationalBoundaryDiscovered(ctx: ExtensionContext, root: string): void {
	if (!locationalAgentsEnabled() || !ctx.hasUI) return;
	const key = `${path.resolve(ctx.cwd)}\0${path.resolve(root)}`;
	if (notifiedLocationalBoundaryKeys.has(key)) return;
	notifiedLocationalBoundaryKeys.add(key);
	ctx.ui.notify(`Locational boundary discovered: delegate with subagent using locational agent id "${root}"`, "info");
}

export function canonicalPath(value: string): string {
	return realPathIfExists(value);
}

function environmentRoot(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? canonicalPath(value) : undefined;
}

export function getLocationalAncestorStack(): string[] {
	if (!locationalAgentsEnabled()) return [];
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
	if (!locationalAgentsEnabled() || agent.kind !== "locational") return undefined;
	const target = canonicalPath(agent.rootDir);
	const matching = getLocationalAncestorStack().find((root) => root === target);
	if (!matching) return undefined;
	const stack = [...getLocationalAncestorStack(), target].join(" -> ");
	return `Locational delegation loop blocked: locational agent "${agent.id}" resolves to "${target}", which is already active as "${matching}".${stack ? ` Stack: ${stack}.` : ""}`;
}

export function containingLocationalRoot(cwd: string, projectCwd = cwd): string | undefined {
	const behavioralRoots = getBehavioralDefinitionRoots(projectCwd);
	for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
		if (!isBehavioralDefinitionPath(current, behavioralRoots) && fs.existsSync(path.join(current, getAgentInstructionsFileName()))) return canonicalPath(current);
		if (path.dirname(current) === current) return undefined;
	}
}

export function getGuardedLocationalRoots(cwd: string): string[] {
	if (!locationalAgentsEnabled()) return [];
	const active = environmentRoot(CURRENT_LOCATIONAL_ROOT_ENV);
	const roots = scanLocationalAgents(cwd).roots.map(canonicalPath);
	const containing = containingLocationalRoot(cwd);
	if (containing) roots.push(containing);
	return [...new Set(roots)].filter((root) => root !== active);
}

export function makeChildLocationalEnv(agent: AgentConfig): Record<string, string> {
	// Clear inherited ownership when disabled; stale child environment is not opt-in.
	if (!locationalAgentsEnabled()) return { [CURRENT_LOCATIONAL_ROOT_ENV]: "", [LOCATIONAL_ANCESTOR_STACK_ENV]: "" };
	if (agent.kind !== "locational") return {};
	const target = canonicalPath(agent.rootDir);
	return {
		[CURRENT_LOCATIONAL_ROOT_ENV]: target,
		[LOCATIONAL_ANCESTOR_STACK_ENV]: JSON.stringify([...new Set([...getLocationalAncestorStack(), target])]),
	};
}

// Pi 1.4 built-in path-utils parity; shell/custom tools deliberately keep their own spelling.
export function resolveBuiltinTarget(cwd: string, value: string, read = false): string {
	let normalized = value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	if (normalized === "~") normalized = os.homedir();
	else if (normalized.startsWith("~/")) normalized = path.join(os.homedir(), normalized.slice(2));
	if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
	let target = path.resolve(cwd, normalized);
	if (read && !fs.existsSync(target)) {
		const nfd = target.normalize("NFD");
		const variants = [target.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, target.replace(/'/g, "\u2019"), nfd.replace(/'/g, "\u2019")];
		target = variants.find((variant) => fs.existsSync(variant)) ?? target;
	}
	return canonicalPath(target);
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
