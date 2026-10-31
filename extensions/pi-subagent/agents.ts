import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "./pi-compat.ts";

export type AgentOrigin = "bundled" | "user" | "project" | "locational";
export type AgentKind = "behavioral" | "locational";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export interface AgentConfig {
	id: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	whenCallerModelId?: string | string[];
	thenModel?: string;
	thenThinking?: ThinkingLevel;
	manifest: boolean;
	systemPrompt: string;
	origin: AgentOrigin;
	kind: AgentKind;
	overrides?: boolean;
	filePath: string;
	rootDir: string;
	resumable: boolean;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	locationalAgents: AgentConfig[];
	errors: string[];
}

const SUBAGENTS_FILE = "SUBAGENTS.md";
const PORTABLE_PROJECT_AGENTS_DIR = path.join(".agents", "subagents");
const DEFAULT_LOCATIONAL_SCAN_MAX_DEPTH = 6;
const DEFAULT_LOCATIONAL_SCAN_TIMEOUT_MS = 500;
const CALLER_OVERRIDE_KEYS = ["whenCallerModelId", "thenModel", "thenThinking"] as const;
const ALLOWED_FRONTMATTER_KEYS = new Set(["description", "tools", "model", "thinking", "manifest", "resumable", ...CALLER_OVERRIDE_KEYS]);
const SKIP_LOCATIONAL_SCAN_DIRS = new Set([".git", ".hg", ".svn", ".pi", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", "coverage", ".cache", ".turbo", ".parcel-cache", "target", "vendor", "Library", "Temp", "Logs", "obj", "bin"]);
const DEFAULT_LOCATIONAL_PROMPT = `You are a locational subagent. This directory is your source root.

Work only within this source root unless the task explicitly asks otherwise. Delegate work inside nested locational roots listed in the available locational agents section instead of inspecting or modifying them directly.`;

function isDirectory(value: string): boolean {
	try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

function isSymlink(value: string): boolean {
	try { return fs.lstatSync(value).isSymbolicLink(); } catch { return false; }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
	const parsed = Number(process.env[name]?.trim());
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTools(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const tools = (Array.isArray(value) ? value : String(value).split(",")).map((item) => String(item).trim()).filter(Boolean);
	return tools.length ? tools : undefined;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	const normalized = String(value).trim().toLowerCase();
	if (["false", "no", "0", "off"].includes(normalized)) return false;
	if (["true", "yes", "1", "on"].includes(normalized)) return true;
	return fallback;
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	return THINKING_LEVELS.find((level) => level === value);
}

function resolveAtIncludes(body: string, baseDir: string): string {
	return body.split("\n").map((line) => {
		const include = line.trim();
		if (!include.startsWith("@") || include.includes(" ")) return line;
		const filePath = path.resolve(baseDir, include.slice(1));
		const relative = path.relative(baseDir, filePath);
		if (relative.startsWith("..") || path.isAbsolute(relative)) return line;
		try { return fs.statSync(filePath).isFile() ? fs.readFileSync(filePath, "utf8") : line; } catch { return line; }
	}).join("\n");
}

function readInstructions(filePath: string, readBody: boolean): string {
	if (readBody) return fs.readFileSync(filePath, "utf8");
	const fd = fs.openSync(filePath, "r");
	try {
		const chunks: Buffer[] = [];
		const buffer = Buffer.alloc(4096);
		let text = "";
		while (Buffer.byteLength(text, "utf8") < 64 * 1024) {
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead <= 0) break;
			chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
			text = Buffer.concat(chunks).toString("utf8");
			if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return "";
			const match = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
			if (match) return match[0];
		}
		return text;
	} finally {
		fs.closeSync(fd);
	}
}

function loadInstructions(filePath: string, id: string, origin: AgentOrigin, kind: AgentKind, options: { readBody: boolean; rootDir?: string }): { agent?: AgentConfig; error?: string } {
	let content: string;
	try { content = readInstructions(filePath, options.readBody); } catch (error) { return { error: `${filePath}: failed to read (${String(error)})` }; }
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const unknown = Object.keys(frontmatter).filter((key) => !ALLOWED_FRONTMATTER_KEYS.has(key));
	if (unknown.length) return { error: `${filePath}: unsupported frontmatter field(s): ${unknown.join(", ")}` };
	const thinking = parseThinking(frontmatter.thinking);
	if (frontmatter.thinking !== undefined && !thinking) return { error: `${filePath}: unsupported thinking level "${String(frontmatter.thinking)}". Expected one of: ${THINKING_LEVELS.join(", ")}` };
	const hasCallerOverride = CALLER_OVERRIDE_KEYS.some((key) => frontmatter[key] !== undefined);
	const whenCallerModelId = frontmatter.whenCallerModelId;
	const thenThinking = parseThinking(frontmatter.thenThinking);
	if (hasCallerOverride) {
		if (kind !== "behavioral") return { error: `${filePath}: caller overrides are supported only for behavioral agents` };
		if (CALLER_OVERRIDE_KEYS.some((key) => frontmatter[key] === undefined)) return { error: `${filePath}: caller overrides require whenCallerModelId, thenModel, and thenThinking together` };
		const callerIds = Array.isArray(whenCallerModelId) ? whenCallerModelId : [whenCallerModelId];
		if (!callerIds.length || callerIds.some((id) => typeof id !== "string" || !id || /[\s,*?\[\]]/.test(id))) return { error: `${filePath}: whenCallerModelId must be an exact model ID or a nonempty list of exact model IDs, without whitespace, comma-separated candidates, or wildcards` };
		if (frontmatter.thenModel !== "caller" && (typeof frontmatter.thenModel !== "string" || !/^[^/\s,*?\[\]]+\/[^\s,*?\[\]]+$/.test(frontmatter.thenModel))) return { error: `${filePath}: thenModel must be "caller" or one explicit provider/model selector` };
		if (!thenThinking) return { error: `${filePath}: unsupported thenThinking level "${String(frontmatter.thenThinking)}". Expected one of: ${THINKING_LEVELS.join(", ")}` };
	}
	const rootDir = options.rootDir ?? path.dirname(filePath);
	const rawBody = options.readBody ? resolveAtIncludes(body, rootDir).trim() : "";
	return { agent: { id, description: frontmatter.description === undefined ? "" : String(frontmatter.description), tools: parseTools(frontmatter.tools), model: frontmatter.model === undefined ? undefined : String(frontmatter.model), thinking, ...(hasCallerOverride ? { whenCallerModelId: whenCallerModelId as string | string[], thenModel: frontmatter.thenModel as string, thenThinking } : {}), manifest: parseBoolean(frontmatter.manifest, true), resumable: parseBoolean(frontmatter.resumable, kind === "locational"), systemPrompt: rawBody || (kind === "locational" ? DEFAULT_LOCATIONAL_PROMPT : ""), origin, kind, filePath, rootDir } };
}

function loadBehavioralAgentsFromDir(dir: string, origin: "bundled" | "user" | "project"): { agents: AgentConfig[]; errors: string[] } {
	const agents: AgentConfig[] = [];
	const errors: string[] = [];
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { agents, errors }; }
	for (const entry of entries) {
		const rootDir = path.join(dir, entry.name);
		if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDirectory(rootDir))) continue;
		const loaded = loadInstructions(path.join(rootDir, SUBAGENTS_FILE), entry.name, origin, "behavioral", { readBody: true, rootDir });
		if (loaded.error?.includes("failed to read")) continue;
		if (loaded.error) errors.push(loaded.error);
		if (loaded.agent) agents.push(loaded.agent);
	}
	return { agents, errors };
}

function getBehavioralAgentDirs(cwd: string) {
	const legacy = path.resolve(cwd, ".pi", "agents");
	const portable = path.resolve(cwd, PORTABLE_PROJECT_AGENTS_DIR);
	return {
		bundled: path.join(path.dirname(fileURLToPath(import.meta.url)), "agents"),
		user: path.join(getAgentDir(), "agents"),
		project: isDirectory(legacy) ? legacy : isDirectory(portable) ? portable : null,
	};
}

export function getBehavioralDefinitionRoots(cwd: string): string[] {
	// The CWD portable slot remains behavioral-only even when masked by .pi/agents.
	const roots = [...new Set([...Object.values(getBehavioralAgentDirs(cwd)).filter((dir): dir is string => dir !== null), path.resolve(cwd, PORTABLE_PROJECT_AGENTS_DIR)])];
	for (const dir of [...roots]) {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			const definition = path.join(dir, entry.name);
			// Behavioral loading follows direct-child directory symlinks, including overridden or invalid definitions.
			if (entry.isSymbolicLink() && isDirectory(definition) && fs.existsSync(path.join(definition, SUBAGENTS_FILE))) roots.push(definition);
		}
	}
	return roots;
}

export function isBehavioralDefinitionPath(value: string, roots: string[]): boolean {
	return roots.some((root) => {
		const relative = path.relative(root, path.resolve(value));
		return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) || isPathInside(value, root);
	});
}

export function loadLocationalAgent(rootDir: string, options: { readBody: boolean } = { readBody: true }): { agent?: AgentConfig; error?: string } {
	const absoluteRoot = path.resolve(rootDir);
	const filePath = path.join(absoluteRoot, SUBAGENTS_FILE);
	if (!fs.existsSync(filePath)) return { error: `${absoluteRoot}: missing ${SUBAGENTS_FILE}` };
	return loadInstructions(filePath, absoluteRoot, "locational", "locational", { readBody: options.readBody, rootDir: absoluteRoot });
}

export function resolveLocationalAgentId(cwd: string, id: string): AgentConfig | null {
	const requested = path.resolve(cwd, id);
	if (isBehavioralDefinitionPath(requested, getBehavioralDefinitionRoots(cwd))) return null;
	const candidate = realPathIfExists(requested);
	if (!isDirectory(candidate) || !fs.existsSync(path.join(candidate, SUBAGENTS_FILE))) return null;
	return loadLocationalAgent(candidate, { readBody: true }).agent ?? null;
}

export function scanLocationalAgents(cwd: string, options: { maxDepth?: number; timeoutMs?: number } = {}): { agents: AgentConfig[]; errors: string[]; roots: string[] } {
	const agents: AgentConfig[] = [];
	const errors: string[] = [];
	const roots: string[] = [];
	const maxDepth = options.maxDepth ?? readPositiveIntegerEnv("PI_SUBAGENT_LOCATIONAL_SCAN_MAX_DEPTH", DEFAULT_LOCATIONAL_SCAN_MAX_DEPTH);
	const timeoutMs = options.timeoutMs ?? readPositiveIntegerEnv("PI_SUBAGENT_LOCATIONAL_SCAN_TIMEOUT_MS", DEFAULT_LOCATIONAL_SCAN_TIMEOUT_MS);
	const startedAt = Date.now();
	const behavioralRoots = getBehavioralDefinitionRoots(cwd);
	let timedOut = false;
	const visit = (dir: string, depth: number) => {
		if (Date.now() - startedAt > timeoutMs) { timedOut = true; return; }
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (Date.now() - startedAt > timeoutMs) { timedOut = true; return; }
			if (!entry.isDirectory() || SKIP_LOCATIONAL_SCAN_DIRS.has(entry.name)) continue;
			const child = path.join(dir, entry.name);
			if (isBehavioralDefinitionPath(child, behavioralRoots) || isSymlink(child)) continue;
			if (fs.existsSync(path.join(child, SUBAGENTS_FILE))) {
				// Source ownership survives invalid agent metadata.
				roots.push(child);
				const loaded = loadLocationalAgent(child, { readBody: false });
				if (loaded.error) errors.push(loaded.error);
				if (loaded.agent) agents.push(loaded.agent);
			} else if (depth < maxDepth) visit(child, depth + 1);
		}
	};
	visit(path.resolve(cwd), 1);
	if (timedOut) errors.push(`Locational agent scan stopped after ${timeoutMs}ms. Increase PI_SUBAGENT_LOCATIONAL_SCAN_TIMEOUT_MS if needed.`);
	return { agents, errors, roots };
}

export function discoverAgents(cwd: string, trustedProject: boolean, options: { includeLocationalAgents?: boolean } = {}): AgentDiscoveryResult {
	const dirs = getBehavioralAgentDirs(cwd);
	const bundled = loadBehavioralAgentsFromDir(dirs.bundled, "bundled");
	const user = loadBehavioralAgentsFromDir(dirs.user, "user");
	const projectAgentsDir = trustedProject ? dirs.project : null;
	const project = projectAgentsDir ? loadBehavioralAgentsFromDir(projectAgentsDir, "project") : { agents: [], errors: [] };
	const locational = trustedProject && options.includeLocationalAgents !== false ? scanLocationalAgents(cwd) : { agents: [], errors: [] };
	const behavioral = new Map<string, AgentConfig>();
	for (const agent of [...bundled.agents, ...user.agents, ...project.agents]) {
		behavioral.set(agent.id, { ...agent, overrides: behavioral.has(agent.id) });
	}
	return { agents: [...behavioral.values(), ...locational.agents], projectAgentsDir, locationalAgents: locational.agents, errors: [...bundled.errors, ...user.errors, ...project.errors, ...locational.errors] };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	const listed = agents.slice(0, maxItems);
	return { text: listed.length ? listed.map((agent) => `${agent.id} (${agent.origin}): ${agent.description}`).join("; ") : "none", remaining: agents.length - listed.length };
}

function realPathIfExists(value: string): string { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } }
export function isPathInside(candidate: string, root: string): boolean { const relative = path.relative(realPathIfExists(root), realPathIfExists(candidate)); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
export function getAgentInstructionsFileName(): string { return SUBAGENTS_FILE; }
