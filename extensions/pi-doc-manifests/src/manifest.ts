import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { minimatch } from "minimatch";
import { parseDocument } from "yaml";

export const SHARED_MEMORY_PREAMBLE = "These documents are active shared project memory. Use them to preserve cohesion across sessions, developers, and agents, and let project goals, accumulated knowledge, and current progress shape your reasoning and behavior. Documentation must preserve valuable current facts, constraints, and rationale that are not explicit in source. It must describe why the current design exists, not the chronology of how it changed. When the design changes, update, replace, or delete its documentation; rely on version control for superseded history. Proactively suggest creating, revising, distilling, or deleting documents when doing so would preserve implicit knowledge or improve future work. Categories are discovered project responsibilities, not a predefined or exhaustive taxonomy; reuse one only when its declared responsibility fits. Load the `doc-manifests-designer` skill before organizing `.agents/docs` or changing a category or manifest. Discuss and obtain explicit user approval before creating a category; materially expanding its responsibility; changing validation in a way that invalidates existing documents; or renaming, merging, or deleting a category. Each category is a direct-child folder paired with an exact uppercase sibling manifest description; manifests are routing declarations, not indexes. Every category declares a project-local creator skill; load it before creating or substantially revising documents in that category. Each document description is an active routing instruction, not merely a summary: state when the document is relevant, whether it must be read before acting, and what context, rule, or procedure it provides. Keep documents inside paired folders rather than loose under `.agents/docs`. This manifest is injected automatically; avoid duplicating its routing elsewhere.";

export type DocumentEntry = {
  path: string;
  description?: string;
  priority?: unknown;
  frontmatter: Record<string, unknown>;
  body: string;
};

type Diagnostic = {
  path: string;
  code: string;
  detail: string;
};

type FrontmatterRule =
  | { type: "string" }
  | { type: "string[]" }
  | { type: "enum"; values: string[] };

type Validation = {
  frontmatter: Map<string, FrontmatterRule>;
  requiredSections: string[];
  filenamePattern?: string;
};

export type ManifestFolder = {
  name: string;
  description: string;
  documents: DocumentEntry[];
  creatorSkill?: string;
  priorities?: boolean;
  displayFields?: string[];
  validation?: Validation;
};

type ParsedFrontmatter = {
  metadata: Record<string, unknown>;
  body: string;
  malformed?: string;
};

const compare = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const pathFor = (folder: string, path = "") => [folder, path].filter(Boolean).join("/");
const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

function errorDetail(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : String(error);
}

function codeSpan(value: string): string {
  const text = value.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

export function splitFrontmatter(text: string): { metadata: Record<string, unknown>; body: string } {
  const parsed = parseFrontmatter(text);
  return { metadata: parsed.metadata, body: parsed.body };
}

function parseFrontmatter(text: string): ParsedFrontmatter {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { metadata: {}, body: normalized };

  const match = /^---\n([\s\S]*?)^---(?:\n|$)/m.exec(normalized);
  if (!match) return { metadata: {}, body: normalized, malformed: "frontmatter has no closing delimiter" };

  const source = match[1] ?? "";
  const body = normalized.slice(match[0].length);
  try {
    const document = parseDocument(source, { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length > 0) {
      return { metadata: {}, body, malformed: document.errors.map((error) => error.message).join("; ") };
    }
    const value = document.toJS();
    if (value === null) return { metadata: {}, body };
    if (!isRecord(value)) return { metadata: {}, body, malformed: "frontmatter must be a mapping" };
    return { metadata: value, body };
  } catch (error) {
    return { metadata: {}, body, malformed: errorDetail(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addDiagnostic(diagnostics: Diagnostic[], path: string, code: string, detail: string): void {
  diagnostics.push({ path, code, detail });
}

function documentEntry(path: string, contents: string, diagnostics: Diagnostic[], folder: string): DocumentEntry {
  const parsed = parseFrontmatter(contents);
  const projectPath = pathFor(folder, path);
  if (parsed.malformed) addDiagnostic(diagnostics, projectPath, "malformed-frontmatter", parsed.malformed);
  return {
    path,
    description: typeof parsed.metadata.description === "string" ? parsed.metadata.description : undefined,
    priority: parsed.metadata.priority,
    frontmatter: parsed.metadata,
    body: parsed.body,
  };
}

function resolveDisplayFields(
  declaration: Record<string, unknown>,
  frontmatter: Map<string, FrontmatterRule>,
  manifestPath: string,
  diagnostics: Diagnostic[],
): string[] | undefined {
  if (!("display-fields" in declaration)) return undefined;
  const configured = declaration["display-fields"];
  if (!Array.isArray(configured) || !configured.every((field) => typeof field === "string")) {
    addDiagnostic(diagnostics, manifestPath, "invalid-display-fields", "doc-manifest.display-fields must be a string array");
    return undefined;
  }
  const displayFields: string[] = [];
  const seen = new Set<string>();
  for (const field of configured) {
    if (seen.has(field)) {
      addDiagnostic(diagnostics, manifestPath, "duplicate-display-field", `doc-manifest.display-fields.${field}`);
      continue;
    }
    seen.add(field);
    if (!frontmatter.has(field)) {
      addDiagnostic(diagnostics, manifestPath, "unknown-display-field", `doc-manifest.display-fields.${field}`);
      continue;
    }
    displayFields.push(field);
  }
  return displayFields;
}

function parseDeclaration(
  metadata: Record<string, unknown>,
  manifestPath: string,
  diagnostics: Diagnostic[],
): Pick<ManifestFolder, "creatorSkill" | "priorities" | "displayFields" | "validation"> {
  if (!("doc-manifest" in metadata)) {
    addDiagnostic(diagnostics, manifestPath, "missing-creator-skill", "doc-manifest.creator-skill is required");
    return { priorities: false };
  }
  const declaration = metadata["doc-manifest"];
  if (!isRecord(declaration)) {
    addDiagnostic(diagnostics, manifestPath, "invalid-declaration", "doc-manifest must be a mapping");
    return { priorities: false };
  }
  for (const key of Object.keys(declaration)) {
    // Ignore legacy version fields; declarations use one live schema.
    if (!["version", "creator-skill", "priorities", "display-fields", "validation"].includes(key)) {
      addDiagnostic(diagnostics, manifestPath, "unknown-declaration-key", `doc-manifest.${key}`);
    }
  }

  let creatorSkill: string | undefined;
  if (!("creator-skill" in declaration)) {
    addDiagnostic(diagnostics, manifestPath, "missing-creator-skill", "doc-manifest.creator-skill is required");
  } else if (typeof declaration["creator-skill"] === "string" && SKILL_NAME.test(declaration["creator-skill"])) {
    creatorSkill = declaration["creator-skill"];
  } else {
    addDiagnostic(diagnostics, manifestPath, "invalid-creator-skill", "doc-manifest.creator-skill must be a valid skill name");
  }

  let priorities = false;
  if ("priorities" in declaration) {
    if (typeof declaration.priorities === "boolean") priorities = declaration.priorities;
    else addDiagnostic(diagnostics, manifestPath, "invalid-priorities", "doc-manifest.priorities must be boolean");
  }

  if (!("validation" in declaration)) {
    return { creatorSkill, priorities, displayFields: resolveDisplayFields(declaration, new Map(), manifestPath, diagnostics) };
  }
  if (!isRecord(declaration.validation)) {
    addDiagnostic(diagnostics, manifestPath, "invalid-validation", "doc-manifest.validation must be a mapping");
    return { creatorSkill, priorities, displayFields: resolveDisplayFields(declaration, new Map(), manifestPath, diagnostics) };
  }

  const validation: Validation = { frontmatter: new Map(), requiredSections: [] };
  for (const key of Object.keys(declaration.validation)) {
    if (!["frontmatter", "required-sections", "filename-pattern"].includes(key)) {
      addDiagnostic(diagnostics, manifestPath, "unknown-validation-key", `validation.${key}`);
    }
  }

  const frontmatter = declaration.validation.frontmatter;
  if (frontmatter !== undefined) {
    if (!isRecord(frontmatter)) {
      addDiagnostic(diagnostics, manifestPath, "invalid-frontmatter-rules", "validation.frontmatter must be a mapping");
    } else {
      for (const [field, rule] of Object.entries(frontmatter)) {
        if (!isRecord(rule) || typeof rule.type !== "string") {
          addDiagnostic(diagnostics, manifestPath, "invalid-frontmatter-rule", `validation.frontmatter.${field}`);
          continue;
        }
        if (!Object.keys(rule).every((key) => key === "type" || key === "values")) {
          addDiagnostic(diagnostics, manifestPath, "unknown-frontmatter-rule-key", `validation.frontmatter.${field}`);
        }
        if (rule.type === "string" || rule.type === "string[]") {
          if ("values" in rule) addDiagnostic(diagnostics, manifestPath, "invalid-frontmatter-rule", `validation.frontmatter.${field}.values`);
          else validation.frontmatter.set(field, { type: rule.type });
          continue;
        }
        if (rule.type === "enum" && Array.isArray(rule.values) && rule.values.length > 0 && rule.values.every((value) => typeof value === "string" && value.trim().length > 0)) {
          validation.frontmatter.set(field, { type: "enum", values: rule.values });
          continue;
        }
        addDiagnostic(diagnostics, manifestPath, "invalid-frontmatter-rule", `validation.frontmatter.${field}`);
      }
    }
  }

  const displayFields = resolveDisplayFields(declaration, validation.frontmatter, manifestPath, diagnostics);

  const requiredSections = declaration.validation["required-sections"];
  if (requiredSections !== undefined) {
    if (!Array.isArray(requiredSections)) {
      addDiagnostic(diagnostics, manifestPath, "invalid-required-sections", "validation.required-sections must be a string array");
    } else {
      for (const section of requiredSections) {
        if (typeof section === "string" && section.trim().length > 0) validation.requiredSections.push(section);
        else addDiagnostic(diagnostics, manifestPath, "invalid-required-section", "validation.required-sections contains a non-empty string");
      }
    }
  }

  const filenamePattern = declaration.validation["filename-pattern"];
  if (filenamePattern !== undefined) {
    if (typeof filenamePattern === "string" && filenamePattern.trim().length > 0) validation.filenamePattern = filenamePattern;
    else addDiagnostic(diagnostics, manifestPath, "invalid-filename-pattern", "validation.filename-pattern must be a non-empty string");
  }
  return { creatorSkill, priorities, displayFields, validation };
}

async function validateCreatorSkill(cwd: string, creatorSkill: string | undefined, manifestPath: string, diagnostics: Diagnostic[]): Promise<void> {
  if (!creatorSkill) return;
  const relativePath = `.agents/skills/${creatorSkill}/SKILL.md`;
  const skillPath = join(cwd, ".agents", "skills", creatorSkill, "SKILL.md");
  try {
    const stat = await lstat(skillPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      addDiagnostic(diagnostics, manifestPath, "invalid-creator-skill-file", `${relativePath} must be a regular file`);
      return;
    }
    const parsed = parseFrontmatter(await readFile(skillPath, "utf8"));
    if (parsed.malformed || parsed.metadata.name !== creatorSkill || typeof parsed.metadata.description !== "string" || !parsed.metadata.description.trim()) {
      addDiagnostic(diagnostics, manifestPath, "invalid-creator-skill-file", `${relativePath} must define matching name and non-empty description`);
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    addDiagnostic(diagnostics, manifestPath, code === "ENOENT" ? "missing-creator-skill-file" : "unreadable-creator-skill-file", `${relativePath}: ${errorDetail(error)}`);
  }
}

function validFrontmatterValue(rule: FrontmatterRule, value: unknown): boolean {
  return rule.type === "string"
    ? typeof value === "string" && value.trim().length > 0
    : rule.type === "string[]"
      ? Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0)
      : typeof value === "string" && value.trim().length > 0 && rule.values.includes(value);
}

function displayValue(value: string | string[]): string {
  const escape = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n").replace(/[\`*_[\]<>]/g, "\\$&");
  return Array.isArray(value) ? value.map(escape).join(", ") : escape(value);
}

function validateDocument(folder: ManifestFolder, document: DocumentEntry, diagnostics: Diagnostic[]): void {
  const projectPath = pathFor(folder.name, document.path);
  if (!document.description?.trim()) addDiagnostic(diagnostics, projectPath, "missing-description", "description is required");

  for (const [field, rule] of folder.validation?.frontmatter ?? []) {
    if (!validFrontmatterValue(rule, document.frontmatter[field])) addDiagnostic(diagnostics, projectPath, "invalid-frontmatter", `${field} must be ${rule.type}`);
  }

  const headings = new Set<string>();
  let fence: { character: "`" | "~"; length: number } | undefined;
  for (const line of document.body.split("\n")) {
    if (fence !== undefined) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
      if (closing?.[0] === fence.character && closing.length >= fence.length) fence = undefined;
      continue;
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      fence = { character: fenceMatch[1][0] as "`" | "~", length: fenceMatch[1].length };
      continue;
    }
    const heading = /^##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading) headings.add(heading[1]);
  }
  for (const section of folder.validation?.requiredSections ?? []) {
    if (!headings.has(section)) addDiagnostic(diagnostics, projectPath, "missing-section", section);
  }
  if (folder.validation?.filenamePattern && !minimatch(document.path, folder.validation.filenamePattern, { nocase: true })) {
    addDiagnostic(diagnostics, projectPath, "filename-mismatch", folder.validation.filenamePattern);
  }

  if (folder.priorities && document.priority !== undefined && (typeof document.priority !== "string" || !/^p[0-9]+$/.test(document.priority))) {
    addDiagnostic(diagnostics, projectPath, "invalid-priority", typeof document.priority === "string" ? document.priority : "priority must be a string");
  }
}

export function renderManifests(folders: ManifestFolder[], inputDiagnostics: Diagnostic[] = []): string | undefined {
  const diagnostics = [...inputDiagnostics];
  const sections = folders.sort((a, b) => compare(a.name, b.name)).map((folder) => {
    const entries = folder.documents.map((document) => {
      validateDocument(folder, document, diagnostics);
      const priority = typeof document.priority === "string" ? document.priority : undefined;
      const validPriority = priority !== undefined && /^p[0-9]+$/.test(priority);
      const invalidPriority = document.priority !== undefined && !validPriority;
      return { document, marker: !folder.priorities ? undefined : invalidPriority ? "error" : validPriority ? priority : "np", validPriority };
    }).sort((left, right) => {
      if (!folder.priorities) return compare(left.document.path, right.document.path);
      const rank = (entry: typeof left) => entry.marker === "error" ? 0 : entry.validPriority ? 1 : 2;
      if (rank(left) !== rank(right)) return rank(left) - rank(right);
      if (left.validPriority && right.validPriority) {
        const [a, b] = [BigInt(left.marker!.slice(1)), BigInt(right.marker!.slice(1))];
        if (a !== b) return a < b ? -1 : 1;
      }
      return compare(left.document.path, right.document.path);
    });
    const lines = entries.map(({ document, marker }) => {
      const prefix = marker === undefined ? "" : `(${marker}) `;
      const labels = (folder.displayFields ?? []).flatMap((field) => {
        const value = document.frontmatter[field];
        if (value === undefined) return [];
        const rule = folder.validation?.frontmatter.get(field);
        if (!rule) return [];
        return validFrontmatterValue(rule, value) ? [displayValue(value as string | string[])] : ["error"];
      });
      return `- ${prefix}${labels.map((label) => `(${label}) `).join("")}${codeSpan(document.path)}: ${JSON.stringify(document.description?.trim() || "missing description").replaceAll("`", "\\`")}`;
    });
    const creator = folder.creatorSkill ? `\n\nCreator skill: ${codeSpan(folder.creatorSkill)}` : "";
    return `## ${title(folder.name)}\n\n${folder.description || "Manifest description unavailable."}${creator}\n\nDirectory: ${codeSpan(`.agents/docs/${folder.name}/`)}${lines.length ? `\n\n${lines.join("\n")}` : ""}`;
  });

  const unique = new Map<string, Diagnostic>();
  for (const diagnostic of diagnostics) unique.set(`${diagnostic.path}\0${diagnostic.code}\0${diagnostic.detail}`, diagnostic);
  const renderedDiagnostics = [...unique.values()].sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code) || compare(a.detail, b.detail));
  if (renderedDiagnostics.length) {
    sections.push(`## Diagnostics\n\n${renderedDiagnostics.map((diagnostic) => `- (error) ${codeSpan(`.agents/docs/${diagnostic.path}`)} (${diagnostic.code}): ${codeSpan(JSON.stringify(diagnostic.detail))}`).join("\n")}`);
  }
  return sections.length > 0 ? [SHARED_MEMORY_PREAMBLE, ...sections].join("\n\n") : undefined;
}

function title(name: string): string {
  return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

async function readDirectory(path: string, diagnostics: Diagnostic[], relativePath: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(path, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    addDiagnostic(diagnostics, relativePath, "unreadable-directory", errorDetail(error));
    return undefined;
  }
}

async function readRegularFile(path: string, diagnostics: Diagnostic[], relativePath: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return await readFile(path, "utf8");
  } catch (error) {
    addDiagnostic(diagnostics, relativePath, "unreadable-file", errorDetail(error));
    return undefined;
  }
}

async function markdownDocuments(
  directory: string,
  root: string,
  folder: string,
  diagnostics: Diagnostic[],
): Promise<DocumentEntry[]> {
  const entries = await readDirectory(directory, diagnostics, pathFor(folder, relative(root, directory).replaceAll("\\", "/")));
  if (!entries) return [];
  const documents: DocumentEntry[] = [];
  for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      documents.push(...await markdownDocuments(fullPath, root, folder, diagnostics));
      continue;
    }
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    const path = relative(root, fullPath).replaceAll("\\", "/");
    const contents = await readRegularFile(fullPath, diagnostics, pathFor(folder, path));
    if (contents !== undefined) documents.push(documentEntry(path, contents, diagnostics, folder));
  }
  return documents;
}

export async function buildManifest(cwd: string): Promise<string | undefined> {
  const docsRoot = join(cwd, ".agents", "docs");
  const diagnostics: Diagnostic[] = [];
  try {
    const stat = await lstat(docsRoot);
    if (stat.isSymbolicLink()) return undefined;
    if (!stat.isDirectory()) {
      addDiagnostic(diagnostics, "", "invalid-docs-root", ".agents/docs must be a directory");
      return renderManifests([], diagnostics);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    addDiagnostic(diagnostics, "", "unreadable-directory", errorDetail(error));
    return renderManifests([], diagnostics);
  }

  const root = await readDirectory(docsRoot, diagnostics, "");
  if (!root) return renderManifests([], diagnostics);
  const visible = root.filter((entry) => !entry.name.startsWith("."));
  const folders = visible.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  const paired = new Set<string>();
  const manifests: ManifestFolder[] = [];

  for (const folder of folders.sort((a, b) => compare(a.name, b.name))) {
    const guideName = `${folder.name.toUpperCase()}.md`;
    const guide = visible.find((entry) => entry.name === guideName);
    const folderPath = folder.name;
    if (!guide || guide.isSymbolicLink() || !guide.isFile()) {
      addDiagnostic(diagnostics, folderPath, "unpaired-folder", `missing regular ${guideName}`);
      continue;
    }
    const manifestPath = join(docsRoot, guide.name);
    const contents = await readRegularFile(manifestPath, diagnostics, guide.name);
    paired.add(guide.name);
    if (contents === undefined) {
      manifests.push({
        name: folder.name,
        description: "Manifest description unavailable.",
        documents: await markdownDocuments(join(docsRoot, folder.name), join(docsRoot, folder.name), folder.name, diagnostics),
        priorities: false,
      });
      continue;
    }
    const parsed = parseFrontmatter(contents);
    if (parsed.malformed) addDiagnostic(diagnostics, guide.name, "malformed-frontmatter", parsed.malformed);
    else if (!parsed.body.trim()) addDiagnostic(diagnostics, guide.name, "missing-manifest-description", "manifest description body is required");
    const config = parseDeclaration(parsed.metadata, guide.name, diagnostics);
    await validateCreatorSkill(cwd, config.creatorSkill, guide.name, diagnostics);
    manifests.push({
      name: folder.name,
      description: parsed.malformed || !parsed.body.trim() ? "Manifest description unavailable." : parsed.body,
      documents: await markdownDocuments(join(docsRoot, folder.name), join(docsRoot, folder.name), folder.name, diagnostics),
      ...config,
    });
  }

  for (const entry of visible.filter((entry) => entry.isFile() && /\.md$/i.test(entry.name)).sort((a, b) => compare(a.name, b.name))) {
    if (paired.has(entry.name)) continue;
    const base = entry.name.slice(0, -3);
    if (base === base.toUpperCase()) addDiagnostic(diagnostics, entry.name, "orphan-manifest", "no paired direct-child folder");
    else addDiagnostic(diagnostics, entry.name, "unexpected-root-markdown", "root Markdown is not a manifest description");
  }
  return renderManifests(manifests, diagnostics);
}
