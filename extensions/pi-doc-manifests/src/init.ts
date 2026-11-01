import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, parse, relative, resolve } from "node:path";

export const CATEGORIES = ["features", "glossary", "goals", "lessons", "runbooks", "standards", "techdebt"] as const;
export const SKILLS = ["doc-feature-creator", "doc-glossary-creator", "doc-goal-creator", "doc-lesson-creator", "doc-runbook-creator", "doc-standard-creator", "doc-techdebt-creator"] as const;
const TEMPLATE_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "templates");

type Result = { ok: true } | { ok: false; message: string };

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : String(error);
}

async function statOrMissing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`cannot inspect ${path}: ${errorCode(error)}`);
  }
}

async function safeCwd(cwd: string): Promise<string | undefined> {
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) return "project path is not canonical";
  const root = parse(cwd).root;
  let current = root;
  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return "project path has an unsafe ancestor";
    for (const part of relative(root, cwd).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return "project path has an unsafe ancestor";
    }
  } catch (error) {
    return `cannot inspect project path: ${errorCode(error)}`;
  }
}

async function loadTemplates(): Promise<Map<string, string> | Result> {
  const files = [
    ...CATEGORIES.map((category) => `docs/${category.toUpperCase()}.md`),
    ...SKILLS.map((skill) => `project-skills/${skill}/SKILL.md`),
  ];
  try {
    return new Map(await Promise.all(files.map(async (file) => [file, await readFile(join(TEMPLATE_ROOT, file), "utf8")] as const)));
  } catch (error) {
    return { ok: false, message: `initialization templates are unavailable: ${errorCode(error)}` };
  }
}

export async function initializeProject(cwd: string): Promise<Result> {
  const templates = await loadTemplates();
  if (!(templates instanceof Map)) return templates;

  const unsafe = await safeCwd(cwd);
  if (unsafe) return { ok: false, message: `Refused: ${unsafe}.` };

  const agentsRoot = join(cwd, ".agents");
  const docsRoot = join(agentsRoot, "docs");
  const skillsRoot = join(agentsRoot, "skills");
  try {
    const agents = await statOrMissing(agentsRoot);
    if (agents && (agents.isSymbolicLink() || !agents.isDirectory())) return { ok: false, message: "Refused: .agents is an unsafe target ancestor." };
    if (await statOrMissing(docsRoot)) return { ok: false, message: "Refused: .agents/docs already exists; initialization never merges or overwrites." };
    const skills = await statOrMissing(skillsRoot);
    if (skills && (skills.isSymbolicLink() || !skills.isDirectory())) return { ok: false, message: "Refused: .agents/skills is an unsafe target ancestor." };
    for (const skill of SKILLS) {
      if (await statOrMissing(join(skillsRoot, skill))) return { ok: false, message: `Refused: .agents/skills/${skill} already exists; initialization never merges or overwrites.` };
    }
  } catch (error) {
    return { ok: false, message: `Refused: target path safety is uncertain (${errorCode(error)}).` };
  }

  try {
    await mkdir(agentsRoot, { recursive: false }).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });
    const agentsNow = await lstat(agentsRoot);
    if (agentsNow.isSymbolicLink() || !agentsNow.isDirectory()) return { ok: false, message: "Refused: .agents is an unsafe target ancestor." };
    await mkdir(docsRoot);
    for (const category of CATEGORIES) {
      await mkdir(join(docsRoot, category));
      await writeFile(join(docsRoot, `${category.toUpperCase()}.md`), templates.get(`docs/${category.toUpperCase()}.md`)!, { flag: "wx" });
    }
    await mkdir(skillsRoot, { recursive: false }).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });
    const skillsNow = await lstat(skillsRoot);
    if (skillsNow.isSymbolicLink() || !skillsNow.isDirectory()) return { ok: false, message: "Refused: .agents/skills is an unsafe target ancestor." };
    for (const skill of SKILLS) {
      const directory = join(skillsRoot, skill);
      await mkdir(directory);
      await writeFile(join(directory, "SKILL.md"), templates.get(`project-skills/${skill}/SKILL.md`)!, { flag: "wx" });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `Initialization failed without overwriting existing content: ${errorCode(error)}.` };
  }
}
