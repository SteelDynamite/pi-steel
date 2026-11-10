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
      assert.match(contents, /When this applies and its primary guidance; when supporting detail must be read\./);
      assert.doesNotMatch(contents, /keywords:/);
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
    assert.match(features, /required-sections: \[Goal\]/);

    const techdebt = await guide("TECHDEBT.md");
    assert.match(techdebt, /priorities: true/);
    assert.match(techdebt, /values: \[backlog, in-progress\]/);
    assert.match(techdebt, /required-sections: \[Debt, Impact, Why we took it, Retirement condition\]/);
    assert.match(techdebt, /display-fields: \[status\]/);

    const standards = await guide("STANDARDS.md");
    assert.match(standards, /required-sections: \[Standard, Scope and exceptions, Rationale and tradeoffs\]/);
    assert.match(standards, /Distinguish requirements from preferences/);

    const goals = await guide("GOALS.md");
    assert.match(goals, /required-sections: \[Intent, Implications\]/);
    for (const category of CATEGORIES) assert.doesNotMatch(await guide(`${category.toUpperCase()}.md`), /keywords:|filename-pattern:/);
    assert.match(await guide("LESSONS.md"), /required-sections: \[Problem, Fix, When to use\]/);
    assert.match(await guide("RUNBOOKS.md"), /required-sections: \[Goal, Preconditions, Steps, Verification, Troubleshooting\]/);
    assert.match(await guide("GLOSSARY.md"), /Project-specific meanings/);
    for (const category of CATEGORIES) assert.doesNotMatch(await guide(`${category.toUpperCase()}.md`), /\n  version:/);

    for (const name of [...CATEGORIES.map((category) => `${category.toUpperCase()}.md`), ...SKILLS]) {
      const path = name.endsWith(".md") ? join(cwd, ".agents", "docs", name) : join(cwd, ".agents", "skills", name, "SKILL.md");
      assert.doesNotMatch(await readFile(path, "utf8"), /\bareas\b/i);
    }
  } finally { await remove(cwd); }
});

test("standards require their three headings and creator examples satisfy every paired declaration", async () => {
  const cwd = await project();
  try {
    assert.deepEqual(await initializeProject(cwd), { ok: true });
    const standards = join(cwd, ".agents", "docs", "standards");
    for (const [index, category] of CATEGORIES.entries()) {
      const creator = await readFile(join(cwd, ".agents/skills", SKILLS[index]!, "SKILL.md"), "utf8");
      const example = /```md\n([\s\S]*?)\n```/.exec(creator)?.[1];
      assert.ok(example, category);
      await writeFile(join(cwd, ".agents/docs", category, "example.md"), example);
    }
    assert.doesNotMatch(await buildManifest(cwd) ?? "", /## Diagnostics/);
    const metadata = "---\ndescription: Use this convention.\n---\n";
    await writeFile(join(standards, "missing-sections.md"), metadata + "# Standard\n\n## Standard\nPrefer this.\n");
    const invalid = await buildManifest(cwd) ?? "";
    assert.match(invalid, /missing-section.*Scope and exceptions/);
    assert.match(invalid, /missing-section.*Rationale and tradeoffs/);
    await writeFile(join(standards, "invalid.md"), "# Missing metadata\n");
    assert.match(await buildManifest(cwd) ?? "", /## Diagnostics/);
    const skill = await readFile(join(cwd, ".agents", "skills", "doc-standard-creator", "SKILL.md"), "utf8");
    assert.match(skill, /unnumbered kebab-case/);
    assert.match(skill, /exactly the three H2 headings/);
    assert.deepEqual([...skill.matchAll(/^## (.+)$/gm)].map(match => match[1]), ["Standard", "Scope and exceptions", "Rationale and tradeoffs"]);
    assert.match(skill, /ask the owner rather than inventing/);
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
    assert.deepEqual(notifications.pop(), { message: "Initialized example .agents/docs categories and project-local doc-* skills. Reload Pi resources to load the project skills.", level: "info" });
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
  assert.match(designer, /active routing instructions, not merely summaries/);
  assert.match(designer, /doc-manifest\.creator-skill/);
  assert.match(designer, /do not invent approval gates/);
  assert.match(designer, /project-specific gate/);
  assert.doesNotMatch(designer, /\b(?:features|glossary|goals|lessons|policies|runbooks|standards|techdebt)\b/);
  assert.match(designer, /A description may suffice/);

  const maintainer = await readFile("skills/doc-manifests-maintainer/SKILL.md", "utf8");
  assert.match(maintainer, /name: doc-manifests-maintainer/);
  assert.match(maintainer, /mechanical[\s\S]*semantic[\s\S]*structural/);
  assert.match(maintainer, /doc-manifest\.creator-skill/);
  assert.match(maintainer, /Act autonomously within clear project intent/);
  assert.match(maintainer, /\.pi-doc-manifests-layout-version/);
  assert.match(maintainer, /doc-manifest\.version/);
  assert.match(maintainer, /Use `doc-manifests-designer`/);
  assert.match(maintainer, /Existing Decisions, Policies, numbered filenames and custom categories remain supported/);
  assert.match(maintainer, /old-to-new path map/);
  assert.match(maintainer, /case-insensitive collisions/);
  assert.match(maintainer, /Protect affected files outside the scanned tree/);
  assert.match(maintainer, /Git-ignored files/);
  assert.match(maintainer, /three ordered sections/);
  assert.match(maintainer, /Leave existing session data untouched/);
  assert.match(maintainer, /If already consolidated, leave it unchanged/);

  const reviewer = await readFile("skills/doc-manifests-session-reviewer/SKILL.md", "utf8");
  assert.match(reviewer, /name: doc-manifests-session-reviewer/);
  assert.match(reviewer, /\$PI_SESSION_FILE/);
  assert.match(reviewer, /Do not preload category creator skills/);
  assert.match(reviewer, /As soon as a candidate document change is identified, load/);
  assert.match(reviewer, /otherwise act without asking/);
  assert.match(reviewer, /Follow project-specific approval requirements/);
  assert.match(reviewer, /No documentation changes needed/);
  assert.doesNotMatch(reviewer, /\b(?:decisions|features|glossary|goals|lessons|policies|runbooks|standards|techdebt)\b/);
  assert.doesNotMatch(reviewer, /README\.md|AGENTS\.md/);
  const runbook = await readFile("templates/project-skills/doc-runbook-creator/SKILL.md", "utf8");
  assert.match(runbook, /READ–DO[\s\S]*DO–CONFIRM/);
  assert.match(runbook, /not instructions to repeat completed work/);
  assert.match(runbook, /After use, directly apply improvements/);
  const lesson = await readFile("templates/project-skills/doc-lesson-creator/SKILL.md", "utf8");
  assert.match(lesson, /external dependencies outside the project's control/);
  assert.match(lesson, /hypothesis and working mitigation are sufficient/);

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
