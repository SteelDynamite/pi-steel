import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { DefaultPackageManager, SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import { transactSettings, type MemoryThresholds } from "./settings.js";

export interface Member {
  id: string;
  source: string;
  revision: string;
  entry: string;
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  assets?: string[];
}
export interface Loadout { bundled: string[]; external: string[] }
/** steel.json is global-only. Shipped names and full/minimal are reserved; custom loadouts require both arrays.
 * External sources use Pi syntax; relative local paths resolve from getAgentDir().
 * `managed` is internal ownership state, not user-selected resources; do not edit it.
 * Never infer ownership from installation alone. */
export interface Config {
  version: 1;
  active: string;
  loadouts: Record<string, Loadout>;
  managed: PackageSource[];
  /** Interrupted settings-write journal; accepts only our old and proposed declarations. */
  pending?: PackageSource[];
  /** Downloads interrupted before the host reported success; cache existence is insufficient. */
  incomplete?: string[];
}
export const sourceOf = (entry: PackageSource): string => typeof entry === "string" ? entry : entry.source;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string" && v.trim() === v && v.length > 0) && new Set(value).size === value.length;
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error("Unknown configuration field");
}
/** Read on demand so package updates change definitions, not local ownership state. */
export function readLoadouts(): { version: 1; default: string; loadouts: Record<string, Loadout> } {
  const value: unknown = JSON.parse(readFileSync(new URL("../loadouts.json", import.meta.url), "utf8"));
  if (!record(value)) throw new Error("loadouts.json must be an object");
  keys(value, ["version", "default", "loadouts"]);
  if (value.version !== 1 || typeof value.default !== "string" || !record(value.loadouts) || !Object.hasOwn(value.loadouts, value.default)) throw new Error("Invalid shipped loadouts version, default, or loadouts");
  for (const name of Object.keys(value.loadouts)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || ["full", "minimal"].includes(name)) throw new Error(`Reserved or invalid shipped loadout: ${name}`);
  }
  return value as { version: 1; default: string; loadouts: Record<string, Loadout> };
}
/** Only these three settings are Steel-owned; load from the shipped artifact on every plan. */
export function readMemoryThresholds(): MemoryThresholds {
  const value: unknown = JSON.parse(readFileSync(new URL("../presets/memory/settings.json", import.meta.url), "utf8"));
  if (!record(value)) throw new Error("Invalid shipped memory settings");
  keys(value, ["observational-memory"]);
  const thresholds = value["observational-memory"];
  const names = ["observeAfterTokens", "reflectAfterTokens", "compactAfterTokens"];
  if (!record(thresholds)) throw new Error("Invalid shipped memory thresholds");
  keys(thresholds, names);
  if (names.some(name => !Number.isSafeInteger(thresholds[name]) || (thresholds[name] as number) <= 0)) throw new Error("Memory thresholds must be positive safe integers");
  return thresholds as MemoryThresholds;
}
function validateLoadout(name: string, loadout: unknown, members: Member[]): asserts loadout is Loadout {
  if (!record(loadout)) throw new Error(`Invalid loadout: ${name}`);
  keys(loadout, ["bundled", "external"]);
  if (!strings(loadout.bundled) || !strings(loadout.external)) throw new Error(`Loadout ${name} requires unique bundled/external string arrays`);
  for (const id of loadout.bundled) if (!members.some(m => m.id === id)) throw new Error(`Unknown bundled ID: ${id}`);
}
export function parseConfig(value: unknown, members: Member[]): Config {
  if (!record(value)) throw new Error("steel.json must be an object");
  keys(value, ["version", "active", "loadouts", "managed", "pending", "incomplete"]);
  if (value.incomplete !== undefined && !strings(value.incomplete)) throw new Error("incomplete must be a unique source array");
  if (value.version !== 1 || typeof value.active !== "string" || !record(value.loadouts)) throw new Error("Invalid steel.json version, active, or loadouts");
  const shipped = readLoadouts();
  for (const [name, loadout] of Object.entries(value.loadouts)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || ["full", "minimal"].includes(name) || Object.hasOwn(shipped.loadouts, name)) throw new Error(`Reserved or invalid loadout: ${name}`);
    validateLoadout(name, loadout, members);
  }
  const managed = value.managed ?? [];
  if (!Array.isArray(managed) || (value.pending !== undefined && !Array.isArray(value.pending))) throw new Error("managed/pending must be arrays");
  for (const entry of [...managed, ...(value.pending as unknown[] ?? [])]) {
    if (!record(entry) || typeof entry.source !== "string" || !entry.source || entry.source.trim() !== entry.source) throw new Error("Invalid managed declaration");
    keys(entry, ["source", "extensions", "skills", "prompts", "themes"]);
    for (const type of resourceTypes) if (entry[type] !== undefined && !strings(entry[type])) throw new Error(`Invalid managed ${type}`);
  }
  const config = { ...value, managed } as unknown as Config;
  select(config, members);
  return config;
}
export function readConfig(path: string, members: Member[]): Config {
  return existsSync(path) ? parseConfig(JSON.parse(readFileSync(path, "utf8")), members) : { version: 1, active: readLoadouts().default, loadouts: {}, managed: [] };
}
export function saveConfig(path: string, config: Config): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}
export function select(config: Config, members: Member[]): Loadout {
  if (config.active === "full") return { bundled: members.map(m => m.id), external: [] };
  if (config.active === "minimal") return { bundled: [], external: [] };
  const shipped = readLoadouts();
  const loadouts = Object.hasOwn(shipped.loadouts, config.active) ? shipped.loadouts : config.loadouts;
  if (!Object.hasOwn(loadouts, config.active)) throw new Error(`Unknown loadout: ${config.active}`);
  const loadout = loadouts[config.active];
  validateLoadout(config.active, loadout, members);
  return loadout;
}
const resourceTypes = ["extensions", "skills", "prompts", "themes"] as const;
export function bundledFilters(source: string, members: Member[], enabled: string[]): PackageSource {
  return {
    source,
    // Exclude first, then exact-includes: plain 'index.ts' matches every basename in Pi.
    extensions: ["!**/*", "+index.ts", ...members.filter(m => enabled.includes(m.id)).map(m => `+${m.entry}`)],
    ...Object.fromEntries(resourceTypes.slice(1).map(type => [type, members.filter(m => enabled.includes(m.id)).flatMap(m => m[type as "skills" | "prompts" | "themes"] ?? []).map(path => `${path}/**/*`)])),
  };
}
export const externalFilters = (source: string, enabled: boolean): PackageSource => enabled ? { source } : { source, extensions: [], skills: [], prompts: [], themes: [] };

/** Delegate identity to the public host matcher, using only an in-memory settings store.
 * It handles npm versions, Git transports/refs, and scope-relative local paths without duplicating Pi's parser. */
export function sameSource(a: string, baseA: string, b: string, baseB = baseA): boolean {
  const settings = SettingsManager.inMemory({ packages: [a] });
  return new DefaultPackageManager({ cwd: baseB, agentDir: baseA, settingsManager: settings }).removeSourceFromSettings(b);
}
const canonical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Identify local aliases and direct entry files as well as standalone packages. */
function bundledConflict(installed: string, root: string, members: Member[], incomplete = false): string | undefined {
  const path = canonical(installed);
  if (path === canonical(root) || path === canonical(join(root, "index.ts"))) return "manager";
  const member = members.find(member => path === canonical(join(root, member.entry)) || path === canonical(dirname(join(root, member.entry))));
  if (member) return member.id;
  // Journaled downloads may contain malformed metadata. Inspect it after a
  // successful repair; canonical bundled paths and source identities still apply.
  if (incomplete || !existsSync(path)) return;
  let directory = statSync(path).isDirectory() ? path : dirname(path);
  while (dirname(directory) !== directory) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const name = JSON.parse(readFileSync(manifest, "utf8")).name;
      return name === "pi-steel" ? "manager" : members.find(member => member.id === name)?.id;
    }
    directory = dirname(directory);
  }
}

type PackageHost = Pick<DefaultPackageManager, "getInstalledPath" | "install">;
type ProjectDeclarations = ReturnType<SettingsManager["getProjectSettings"]>;
export interface Plan { packages: PackageSource[]; managed: PackageSource[]; install: string[]; changed: boolean; projectExcluded: string[]; memoryThresholds?: MemoryThresholds }
export function plan(config: Config, members: Member[], settings: SettingsManager, host: PackageHost, root: string, agentDir: string, cwd: string, projectDeclarations = settings.getProjectSettings()): Plan {
  const loadout = select(config, members);
  const current = settings.getGlobalSettings().packages ?? [];
  // Inspect untrusted project declarations too: refusing a conflict does not execute their code.
  const project = projectDeclarations.packages ?? [];
  const isRoot = (entry: PackageSource, scope: "user" | "project"): boolean => {
    const path = host.getInstalledPath(sourceOf(entry), scope);
    return path !== undefined && canonical(path) === canonical(root);
  };
  const roots = current.filter(entry => isRoot(entry, "user"));
  if (roots.length !== 1) throw new Error("Steel requires exactly one global package declaration pointing to its package directory; install the directory/Git/npm package, not index.ts or only -e");
  const rootEntry = roots[0]!;
  const rootSource = sourceOf(rootEntry);
  // Pi applies same-identity project deltas to the global installation. A physical
  // alias is not enough: a different host identity can load a second copy.
  const overrides = project.filter(entry => sameSource(rootSource, agentDir, sourceOf(entry), join(cwd, ".pi")));
  if (overrides.length > 1) throw new Error("Project Steel declaration must be a single exclusion delta");
  const override = overrides[0];
  let projectExcluded: string[] = [];
  if (override !== undefined) {
    if (typeof override === "string" || override.autoload !== false) throw new Error("Project Steel declaration requires autoload: false and whole-extension exclusions");
    keys(override, ["source", "autoload", ...resourceTypes]);
    for (const type of resourceTypes) if (override[type] !== undefined && !strings(override[type])) throw new Error(`Invalid project Steel ${type}`);
    const exclusions = override.extensions ?? [];
    const excluded = members.filter(member => exclusions.includes(`-${member.entry}`));
    if (excluded.length !== exclusions.length) throw new Error("Project Steel extensions must use -<bundled entry path>; manager, inclusions, and globs are not allowed");
    // Accept only complete companion-directory exclusions, not arbitrary globs or
    // independent companion toggles. Directory filters also cover new files.
    for (const type of ["skills", "prompts", "themes"] as const) {
      const expected = new Set(excluded.flatMap(member => member[type] ?? []).map(path => `!${path}/**/*`));
      const actual = override[type] ?? [];
      if (actual.length !== expected.size || actual.some(pattern => !expected.has(pattern))) throw new Error(`Project Steel ${type} must exclude exactly the disabled extensions' companions: ${[...expected].join(", ") || "none"}`);
    }
    projectExcluded = excluded.map(member => member.id);
  }
  const all = [...current.map(entry => ({ entry, base: agentDir, scope: "user" as const })), ...project.map(entry => ({ entry, base: join(cwd, ".pi"), scope: "project" as const }))];
  for (let i = 0; i < config.managed.length; i++) {
    if (config.managed.slice(0, i).some(entry => sameSource(sourceOf(entry), agentDir, sourceOf(config.managed[i]!)))) throw new Error("Duplicate managed package identity");
  }
  for (const [paths, scope] of [[settings.getGlobalSettings().extensions ?? [], "user"], [projectDeclarations.extensions ?? [], "project"]] as const) {
    for (const raw of paths) {
      if (raw.startsWith("-") || raw.startsWith("!")) continue;
      const installed = host.getInstalledPath(raw.replace(/^\+/, ""), scope);
      if (!installed) continue;
      const conflict = bundledConflict(installed, root, members);
      if (conflict) throw new Error(`Direct standalone extension conflicts with bundled ${conflict}: ${raw}`);
    }
  }
  const ownership = [...config.managed, ...config.pending ?? []];
  const candidates = [...ownership.map(sourceOf), ...loadout.external];
  const isManager = (source: string, base = agentDir): boolean =>
    sameSource("npm:pi-steel", agentDir, source, base) || sameSource("git:github.com/SteelDynamite/pi-steel", agentDir, source, base);
  for (const source of candidates) {
    const installed = host.getInstalledPath(source, "user");
    // Pi's local-file branch ignores package filters, so these cannot be deactivated.
    if (installed && statSync(installed).isFile()) throw new Error(`External file sources cannot be managed: ${source}`);
    if (isManager(source)) throw new Error(`External source duplicates bundled manager: ${source}`);
  }
  for (let i = 0; i < loadout.external.length; i++) {
    const source = loadout.external[i]!;
    if (sameSource(source, agentDir, rootSource) || loadout.external.slice(0, i).some(other => sameSource(source, agentDir, other))) throw new Error(`Duplicate/manager external identity: ${source}`);
  }
  for (const item of all) {
    if (item.entry === rootEntry || (item.scope === "project" && item.entry === override)) continue;
    const source = sourceOf(item.entry);
    const installed = host.getInstalledPath(source, item.scope);
    const conflict = installed ? bundledConflict(installed, root, members, config.incomplete?.includes(source)) : undefined;
    if (conflict || isManager(source, item.base)) throw new Error(`Standalone ${conflict ?? "manager"} conflicts with bundled ownership: ${source}; remove its declaration explicitly`);
    for (const member of members) {
      if (sameSource(member.source, agentDir, source, item.base)) throw new Error(`Standalone ${member.id} conflicts with bundled ownership: ${source}; remove its declaration explicitly`);
    }
    if (!candidates.some(candidate => sameSource(candidate, agentDir, source, item.base))) continue;
    const owned = ownership.some(entry => sameSource(sourceOf(entry), agentDir, source, item.base) && equal(entry, item.entry));
    if (item.scope !== "user" || !owned) throw new Error(`External package is manual, modified, or project-owned: ${source}; Steel will not claim it`);
  }
  for (const source of loadout.external) {
    if (members.some(member => sameSource(member.source, agentDir, source))) throw new Error(`External source duplicates bundled member: ${source}`);
    // Check candidates before admission and again after download; they are not
    // present in current settings yet and must not bypass bundled ownership.
    const installed = host.getInstalledPath(source, "user");
    const conflict = installed ? bundledConflict(installed, root, members, config.incomplete?.includes(source)) : undefined;
    if (conflict) throw new Error(`External source duplicates bundled ${conflict}: ${source}`);
  }
  const managed = [...config.managed];
  for (const entry of config.pending ?? []) if (!managed.some(previous => sameSource(sourceOf(previous), agentDir, sourceOf(entry)))) managed.push(entry);
  for (let i = 0; i < managed.length; i++) managed[i] = externalFilters(sourceOf(managed[i]!), loadout.external.includes(sourceOf(managed[i]!)));
  for (const source of loadout.external) {
    const previous = managed.find(entry => sameSource(sourceOf(entry), agentDir, source));
    if (previous && sourceOf(previous) !== source) throw new Error(`Managed source identity changed ref/spelling: ${source}; retain the original source or remove its managed record and declaration explicitly`);
    if (!previous) managed.push(externalFilters(source, true));
  }
  const packages = current.map(entry => entry === rootEntry ? bundledFilters(rootSource, members, loadout.bundled) : managed.find(owned => sameSource(sourceOf(owned), agentDir, sourceOf(entry))) ?? entry);
  for (const entry of managed) if ((loadout.external.includes(sourceOf(entry)) || host.getInstalledPath(sourceOf(entry), "user")) && !packages.some(existing => sameSource(sourceOf(existing), agentDir, sourceOf(entry)))) packages.push(entry);
  // A cached checkout alone does not establish that the requested ref/version was installed.
  // Reinstall newly claimed/restored declarations through Pi, even when cache files exist.
  const install = loadout.external.filter(source => config.incomplete?.includes(source) || !host.getInstalledPath(source, "user") || !current.some(entry => sameSource(sourceOf(entry), agentDir, source)));
  let memoryThresholds: MemoryThresholds | undefined;
  let memoryChanged = false;
  if (loadout.external.some(source => sameSource("git:https://github.com/elpapi42/pi-observational-memory.git", agentDir, source))) {
    memoryThresholds = readMemoryThresholds();
    // OM reads project settings directly, independently of Pi's trust decision.
    // Refuse shadowed policy rather than writing project files or unowned mode keys.
    for (const [scope, document] of [["Global", settings.getGlobalSettings()], ["Project", projectDeclarations]] as const) {
      const memory = (document as Record<string, unknown>)["observational-memory"];
      if (memory === undefined) {
        if (scope === "Global") memoryChanged = true;
        continue;
      }
      if (!record(memory)) throw new Error(`${scope} observational-memory settings must be an object; settings unchanged`);
      if (memory.compactAfterTokensMode === "ratio") throw new Error(`${scope} observational-memory compactAfterTokensMode conflicts with Steel's fixed thresholds; remove it or select calibrated mode explicitly`);
      for (const [key, value] of Object.entries(memoryThresholds)) {
        if (scope === "Project" && Object.hasOwn(memory, key) && memory[key] !== value) throw new Error(`Project observational-memory ${key} conflicts with Steel's managed value; remove the override explicitly`);
        if (scope === "Global" && memory[key] !== value) memoryChanged = true;
      }
    }
  }
  return { packages, managed, install, changed: !equal(packages, current) || memoryChanged, projectExcluded, ...(memoryThresholds ? { memoryThresholds } : {}) };
}

/** Downloads precede declaration changes. The host has no cancellation API for install();
 * a failed download may leave cache files, but never authorizes loading a partial member. */
export async function synchronize(config: Config, members: Member[], settings: SettingsManager, host: PackageHost, root: string, agentDir: string, cwd: string, configPath: string, projectDeclarations?: ProjectDeclarations): Promise<{ changed: boolean; installed: string[] }> {
  await settings.flush();
  const initial = plan(config, members, settings, host, root, agentDir, cwd, projectDeclarations);
  const installed: string[] = [];
  for (const source of initial.install) {
    const journal = readConfig(configPath, members);
    config.incomplete = [...new Set([...(config.incomplete ?? []), source])];
    saveConfig(configPath, { ...journal, incomplete: config.incomplete });
    try {
      await host.install(source);
      if (!host.getInstalledPath(source, "user")) throw new Error("Installed package missing");
      installed.push(source);
      config.incomplete = config.incomplete.filter(entry => entry !== source);
      saveConfig(configPath, { ...journal, incomplete: config.incomplete });
    }
    catch (error) { throw new Error(`Sync incomplete: failed installing ${source}; completed downloads: ${installed.join(", ") || "none"}. No resource declarations changed. ${String(error)}`); }
  }
  // Reload after downloads rather than overwriting packages changed by an ordinary pi install.
  await settings.reload();
  const loadErrors = settings.drainErrors();
  if (loadErrors.length) throw new Error(`Sync incomplete: settings reload failed: ${loadErrors.map(e => e.error.message).join("; ")}`);
  let next: Plan;
  try {
    next = transactSettings(cwd, agentDir, snapshot => {
      // Revalidate ownership, manual packages, and project declarations at commit.
      const rebased = plan(config, members, snapshot, host, root, agentDir, cwd);
      if (rebased.install.some(source => !installed.includes(source) || !host.getInstalledPath(source, "user"))) throw new Error("installed package missing; settings unchanged");
      // Journal before the settings write, while still holding its lock.
      saveConfig(configPath, { ...config, pending: rebased.managed });
      return rebased;
    });
  } catch (error) {
    throw new Error(`Sync incomplete: settings write failed: ${String(error)}`);
  }
  await settings.reload();
  const errors = settings.drainErrors();
  if (errors.length) throw new Error(`Sync incomplete: final settings reload failed: ${errors.map(e => e.error.message).join("; ")}`);
  const { pending: _pending, incomplete: _incomplete, ...committed } = config;
  saveConfig(configPath, { ...committed, ...(config.incomplete?.length ? { incomplete: config.incomplete } : {}), managed: next.managed });
  return { changed: next.changed || installed.length > 0 || config.pending !== undefined, installed };
}
