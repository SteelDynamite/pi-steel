import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index";
import { CATEGORIES, initializeProject, SKILLS } from "../src/init";
import { buildManifest } from "../src/manifest";

const execFileAsync = promisify(execFile);
const expectedCategories = ["features", "glossary", "goals", "lessons", "runbooks", "standards", "techdebt"];
const expectedSkills = ["doc-feature-creator", "doc-glossary-creator", "doc-goal-creator", "doc-lesson-creator", "doc-runbook-creator", "doc-standard-creator", "doc-techdebt-creator"];

async function project(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "pi-doc-manifests-init-"));
}

async function remove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

test("initializes the optional example layout and exact project skills", async () => {
  const cwd = await project();
  try {
    await mkdir(join(cwd, ".agents", "skills", "unrelated"), { recursive: true });
    assert.deepEqual([...CATEGORIES], expectedCategories);
    assert.deepEqual([...SKILLS], expectedSkills);
    assert.deepEqual(await initializeProject(cwd), { ok: true });

    const docs = join(cwd, ".agents", "docs");
    assert.deepEqual((await readdir(docs)).sort(), [...CATEGORIES.map((category) => category.toUpperCase() + ".md"), ...CATEGORIES].sort());
    for (const [index, category] of CATEGORIES.entries()) {
      const guide = await readFile(join(docs, `${category.toUpperCase()}.md`), "utf8");
      assert.equal(guide, await readFile(join("templates", "docs", `${category.toUpperCase()}.md`), "utf8"));
      assert.match(guide, new RegExp(`creator-skill: ${SKILLS[index]}`));
    }
    assert.deepEqual((await readdir(join(cwd, ".agents", "skills"))).filter((name) => name !== "unrelated").sort(), [...expectedSkills].sort());
    for (const skill of SKILLS) {
      const contents = await readFile(join(cwd, ".agents", "skills", skill, "SKILL.md"), "utf8");
      assert.match(contents, new RegExp(`name: ${skill}`));
      assert.match(contents, /When this document is relevant or must be read; what it provides\./);
    }

    const manifest = await buildManifest(cwd) ?? "";
    for (const category of CATEGORIES) assert.match(manifest, new RegExp(`## ${category[0].toUpperCase()}${category.slice(1)}`));
    assert.doesNotMatch(manifest, /## Diagnostics|layout-version/);
  } finally { await remove(cwd); }
});

test("example initialization guides retain their validation contracts", async () => {
  const cwd = await project();
  try {
    assert.deepEqual(await initializeProject(cwd), { ok: true });
    const guide = async (name: string) => await readFile(join(cwd, ".agents", "docs", name), "utf8");
    const features = await guide("FEATURES.md");
    assert.match(features, /priorities: true/);
    assert.match(features, /display-fields: \[status\]/);
    assert.match(features, /values: \[draft, ready, in-progress\]/);
    assert.match(features, /keywords:\n        type: string\[\]/);
    assert.match(features, /required-sections: \[Goal\]/);
    assert.match(features, /filename-pattern: "\*\*\/\*\.md"/);

    const techdebt = await guide("TECHDEBT.md");
    assert.match(techdebt, /priorities: true/);
    assert.match(techdebt, /values: \[backlog, in-progress\]/);
    assert.match(techdebt, /required-sections: \[Debt, Impact, Why we took it, Retirement condition\]/);
    assert.match(techdebt, /keywords:\n        type: string\[\]/);

    const standards = await guide("STANDARDS.md");
    assert.doesNotMatch(standards, /required-sections/);
    assert.match(standards, /filename-pattern: "\*\*\/\*\.md"/);
    assert.match(standards, /keywords:\n        type: string\[\]/);
    assert.equal(standards.split("---\n")[2]?.trim(), "Consequential choices explaining the current design, the intentions behind it, and its tradeoffs, or rules that must be followed as part of the project's conventions.");

    const goals = await guide("GOALS.md");
    assert.match(goals, /required-sections: \[Intent, Implications\]/);
    assert.match(goals, /keywords:\n        type: string\[\]/);
    for (const name of ["LESSONS.md", "RUNBOOKS.md"]) assert.match(await guide(name), /keywords:\n        type: string\[\]/);
    assert.match(await guide("LESSONS.md"), /required-sections: \[Problem, Fix, When to use\]/);
    assert.match(await guide("RUNBOOKS.md"), /required-sections: \[Goal, Preconditions, Steps, Verification, Troubleshooting\]/);
    assert.match(await guide("GLOSSARY.md"), /filename-pattern: "\*\*\/\*\.md"/);
    for (const category of CATEGORIES) assert.doesNotMatch(await guide(`${category.toUpperCase()}.md`), /\n  version:/);

    for (const name of [...CATEGORIES.map((category) => `${category.toUpperCase()}.md`), ...SKILLS]) {
      const path = name.endsWith(".md") ? join(cwd, ".agents", "docs", name) : join(cwd, ".agents", "skills", name, "SKILL.md");
      assert.doesNotMatch(await readFile(path, "utf8"), /\bareas\b/i);
    }
  } finally { await remove(cwd); }
});

test("standards accept unnumbered choices and rules without a combined heading contract", async () => {
  const cwd = await project();
  try {
    assert.deepEqual(await initializeProject(cwd), { ok: true });
    const standards = join(cwd, ".agents", "docs", "standards");
    const metadata = "---\ndescription: Read before changing this standard.\nkeywords: [design]\n---\n";
    await writeFile(join(standards, "design-choice.md"), metadata + "# Choice\n\n## Context\nNeed.\n\n## Options considered\nTradeoffs.\n\n## Decision\nChoice.\n\n## Consequences\nCosts.\n");
    await writeFile(join(standards, "mandatory-rule.md"), metadata + "# Rule\n\n## Rule\nDo this.\n\n## Applies to\nThis project.\n");
    await writeFile(join(standards, "small-standard.md"), metadata + "# Small standard\n\nA choice and its rationale.\n");
    const manifest = await buildManifest(cwd) ?? "";
    for (const name of ["design-choice.md", "mandatory-rule.md", "small-standard.md"]) assert.ok(manifest.includes(name));
    assert.doesNotMatch(manifest, /## Diagnostics/);
    await writeFile(join(standards, "invalid.md"), "# Missing metadata\n");
    assert.match(await buildManifest(cwd) ?? "", /## Diagnostics/);
    const skill = await readFile(join(cwd, ".agents", "skills", "doc-standard-creator", "SKILL.md"), "utf8");
    assert.match(skill, /unnumbered kebab-case/);
    assert.match(skill, /not a mandatory combined shape/);
  } finally { await remove(cwd); }
});

test("existing Decisions and Policies remain valid and are never migrated by scanning or init", async () => {
  const cwd = await project();
  try {
    const original = new Map<string, string>();
    for (const [category, skill, filename, sections] of [
      ["decisions", "doc-decision-creator", "0001-choice.md", ["Context", "Options considered", "Decision", "Consequences"]],
      ["policies", "doc-policy-creator", "rule.md", ["Rule", "Applies to"]],
    ] as const) {
      const docs = join(cwd, ".agents", "docs");
      await mkdir(join(docs, category), { recursive: true });
      await mkdir(join(cwd, ".agents", "skills", skill), { recursive: true });
      original.set(join(docs, `${category.toUpperCase()}.md`), `---\ndoc-manifest:\n  creator-skill: ${skill}\n  validation:\n    required-sections: [${sections.join(", ")}]\n    filename-pattern: "${category === "decisions" ? "[0-9][0-9][0-9][0-9]-*.md" : "**/*.md"}"\n---\nCustom ${category} guidance.\n`);
      original.set(join(docs, category, filename), `---\ndescription: Read before changing this subject.\n---\n# Subject\n\n${sections.map(section => `## ${section}\nCustom content.\n`).join("\n")}`);
      original.set(join(cwd, ".agents", "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: Create custom ${category}.\n---\nPreserve project customization.\n`);
    }
    for (const [path, content] of original) await writeFile(path, content);
    const manifest = await buildManifest(cwd) ?? "";
    assert.match(manifest, /## Decisions/);
    assert.match(manifest, /0001-choice\.md/);
    assert.match(manifest, /## Policies/);
    assert.doesNotMatch(manifest, /## Standards|## Diagnostics/);
    assert.equal((await initializeProject(cwd)).ok, false);
    for (const [path, content] of original) assert.equal(await readFile(path, "utf8"), content);
    await assert.rejects(readdir(join(cwd, ".agents", "docs", "standards")));
    await assert.rejects(readdir(join(cwd, ".agents", "skills", "doc-standard-creator")));
  } finally { await remove(cwd); }
});

test("refuses existing documentation and target skills without merging or overwriting", async () => {
  const initialized = await project();
  const conflict = await project();
  try {
    assert.deepEqual(await initializeProject(initialized), { ok: true });
    const guide = join(initialized, ".agents", "docs", "FEATURES.md");
    await writeFile(guide, "authored");
    const repeat = await initializeProject(initialized);
    assert.equal(repeat.ok, false);
    assert.match(repeat.message, /docs already exists/);
    assert.equal(await readFile(guide, "utf8"), "authored");

    await mkdir(join(conflict, ".agents", "skills", SKILLS[0]), { recursive: true });
    await writeFile(join(conflict, ".agents", "skills", SKILLS[0], "SKILL.md"), "authored");
    const refused = await initializeProject(conflict);
    assert.equal(refused.ok, false);
    assert.match(refused.message, new RegExp(`${SKILLS[0]} already exists`));
    assert.equal(await readFile(join(conflict, ".agents", "skills", SKILLS[0], "SKILL.md"), "utf8"), "authored");
    await assert.rejects(readdir(join(conflict, ".agents", "docs")));
  } finally {
    await remove(initialized);
    await remove(conflict);
  }
});

test("refuses symlinked target ancestors without writing through them", async () => {
  const agentsLink = await project();
  const skillsLink = await project();
  const outside = await project();
  try {
    await mkdir(join(outside, "agents-target"));
    await symlink(join(outside, "agents-target"), join(agentsLink, ".agents"));
    const agentsResult = await initializeProject(agentsLink);
    assert.equal(agentsResult.ok, false);
    assert.match(agentsResult.message, /unsafe target ancestor/);
    await assert.rejects(readdir(join(outside, "agents-target", "docs")));

    await mkdir(join(skillsLink, ".agents"));
    await mkdir(join(outside, "skills-target"));
    await symlink(join(outside, "skills-target"), join(skillsLink, ".agents", "skills"));
    const skillsResult = await initializeProject(skillsLink);
    assert.equal(skillsResult.ok, false);
    assert.match(skillsResult.message, /unsafe target ancestor/);
    await assert.rejects(readdir(join(skillsLink, ".agents", "docs")));
    assert.deepEqual(await readdir(join(outside, "skills-target")), []);
  } finally {
    await remove(agentsLink);
    await remove(skillsLink);
    await remove(outside);
  }
});

test("command accepts only init and requires trust", async () => {
  const cwd = await project();
  try {
    let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
    const notifications: Array<{ message: string; level: string }> = [];
    const appended: unknown[] = [];
    extension({
      on() {},
      appendEntry(_type: string, data: unknown) { appended.push(data); },
      registerEntryRenderer() {},
      registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
        if (name === "doc-manifests") command = options;
      },
    } as unknown as ExtensionAPI);
    assert.ok(command);
    const context = (trusted: boolean) => ({
      cwd,
      isProjectTrusted: () => trusted,
      sessionManager: { getBranch: () => [] },
      ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
    });

    await command.handler("initialize", context(true));
    assert.deepEqual(notifications.pop(), { message: "Usage: /doc-manifests init", level: "warning" });
    await command.handler("init extra", context(true));
    assert.deepEqual(notifications.pop(), { message: "Usage: /doc-manifests init", level: "warning" });
    await command.handler("init", context(false));
    assert.deepEqual(notifications.pop(), { message: "Refused: /doc-manifests init requires a trusted project.", level: "warning" });
    await assert.rejects(readdir(join(cwd, ".agents", "docs")));

    await command.handler("init", context(true));
    assert.deepEqual(notifications.pop(), { message: "Initialized example .agents/docs categories and project-local doc-* skills. Start a new Pi session to load the project skills.", level: "info" });
    assert.equal(appended.length, 1);
  } finally { await remove(cwd); }
});

test("init rebuilds and appends the disk manifest despite an inherited branch snapshot", async () => {
  const cwd = await project();
  try {
    let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
    const appended: Array<{ content: string }> = [];
    extension({
      on() {},
      appendEntry(_type: string, data: { content: string }) { appended.push(data); },
      registerEntryRenderer() {},
      registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
        if (name === "doc-manifests") command = options;
      },
    } as unknown as ExtensionAPI);
    assert.ok(command);

    await command.handler("init", {
      cwd,
      isProjectTrusted: () => true,
      sessionManager: { getBranch: () => [{ type: "custom", customType: "doc-manifests", data: { version: 1, content: "stale branch manifest" } }] },
      ui: { notify() {} },
    });

    const manifest = await buildManifest(cwd);
    assert.ok(manifest);
    assert.deepEqual(appended, [{ content: manifest }]);
    assert.doesNotMatch(appended[0]!.content, /stale branch manifest/);
  } finally { await remove(cwd); }
});

test("packages generic manifest skills while keeping category-specific skills project-local", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { pi?: Record<string, unknown> };
  assert.deepEqual(packageJson.pi?.skills, ["./skills"]);

  const designer = await readFile("skills/doc-manifests-designer/SKILL.md", "utf8");
  assert.match(designer, /name: doc-manifests-designer/);
  assert.match(designer, /not a predefined or exhaustive taxonomy/);
  assert.match(designer, /active routing instruction, not merely a summary/);
  assert.match(designer, /doc-manifest\.creator-skill/);
  assert.match(designer, /require explicit approval before/);
  assert.doesNotMatch(designer, /\b(?:decisions|features|glossary|goals|lessons|policies|runbooks|standards|techdebt)\b/);
  for (const change of ["creating it", "materially expanding", "invalidates existing documents", "renaming, merging, or deleting"]) {
    assert.match(designer, new RegExp(change));
  }

  const maintainer = await readFile("skills/doc-manifests-maintainer/SKILL.md", "utf8");
  assert.match(maintainer, /name: doc-manifests-maintainer/);
  assert.match(maintainer, /mechanical[\s\S]*semantic[\s\S]*structural/);
  assert.match(maintainer, /doc-manifest\.creator-skill/);
  assert.match(maintainer, /ask the user to approve or revise/);
  assert.match(maintainer, /\.pi-doc-manifests-layout-version/);
  assert.match(maintainer, /doc-manifest\.version/);
  assert.match(maintainer, /Load `doc-manifests-designer`/);
  assert.match(maintainer, /Existing Decisions, Policies, numbered filenames, and custom categories remain supported/);
  assert.match(maintainer, /old-to-new path map/);
  assert.match(maintainer, /case-insensitive collisions/);
  assert.match(maintainer, /Back up affected files/);
  assert.match(maintainer, /Git-ignored files/);
  assert.match(maintainer, /rather than combining the old required-heading lists/);
  assert.match(maintainer, /Preserve historical provenance paths and old session data/);
  assert.match(maintainer, /If already migrated, leave it unchanged/);

  const reviewer = await readFile("skills/doc-manifests-session-reviewer/SKILL.md", "utf8");
  assert.match(reviewer, /name: doc-manifests-session-reviewer/);
  assert.match(reviewer, /\$PI_SESSION_FILE/);
  assert.match(reviewer, /Do not preload category creator skills/);
  assert.match(reviewer, /As soon as a candidate document change is identified, load/);
  assert.match(reviewer, /file-specific plan/);
  assert.match(reviewer, /Ask the user to approve or revise/);
  assert.match(reviewer, /No documentation changes needed/);
  assert.doesNotMatch(reviewer, /\b(?:decisions|features|glossary|goals|lessons|policies|runbooks|standards|techdebt)\b/);
  assert.doesNotMatch(reviewer, /README\.md|AGENTS\.md/);

  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"]);
  const packed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  const files = new Set(packed[0]!.files.map((file) => file.path));
  assert.ok(files.has("src/AGENTDOCS.md"));
  assert.ok(!files.has("templates/docs/AGENTDOCS.md"));
  assert.ok(files.has("skills/doc-manifests-designer/SKILL.md"));
  assert.ok(files.has("skills/doc-manifests-maintainer/SKILL.md"));
  assert.ok(files.has("skills/doc-manifests-session-reviewer/SKILL.md"));
  assert.ok(!files.has("skills/doc-manifest-designer/SKILL.md"));
  assert.ok(!files.has("skills/doc-manifest-maintainer/SKILL.md"));
  for (const category of ["DECISIONS", "POLICIES"]) assert.ok(!files.has(`templates/docs/${category}.md`));
  for (const skill of ["doc-decision-creator", "doc-policy-creator"]) assert.ok(!files.has(`templates/project-skills/${skill}/SKILL.md`));
  for (const category of CATEGORIES) assert.ok(files.has(`templates/docs/${category.toUpperCase()}.md`));
  for (const skill of SKILLS) {
    assert.ok(files.has(`templates/project-skills/${skill}/SKILL.md`));
    assert.ok(!files.has(`skills/${skill}/SKILL.md`));
  }
});
