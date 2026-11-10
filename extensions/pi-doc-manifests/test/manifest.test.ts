import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildManifest, renderManifests, SHARED_MEMORY_PREAMBLE, splitFrontmatter, type DocumentEntry } from "../src/manifest";

const document = (path: string, frontmatter: Record<string, unknown>, body = ""): DocumentEntry => ({
  path,
  frontmatter,
  description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
  priority: frontmatter.priority,
  body,
});

async function fixture(setup: (docs: string) => Promise<void>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-doc-manifests-"));
  const docs = join(cwd, ".agents", "docs");
  await setup(docs);
  return cwd;
}

test("uses AGENTDOCS.md as the shared-memory preamble", async () => {
  const preamble = (await readFile(new URL("../src/AGENTDOCS.md", import.meta.url), "utf8")).trim();
  assert.ok(preamble.length > 0);
  assert.equal(SHARED_MEMORY_PREAMBLE, preamble);
  assert.ok(renderManifests([{ name: "notes", description: "Read notes.", documents: [] }])?.startsWith(`${preamble}\n\n## Notes`));
});

test("parses YAML, strips frontmatter, and reports malformed frontmatter", () => {
  assert.deepEqual(splitFrontmatter("---\ndescription: One\nkeywords: [a, b]\n---\nBody\n"), {
    metadata: { description: "One", keywords: ["a", "b"] }, body: "Body\n",
  });
  assert.deepEqual(splitFrontmatter("---\n---\nBody"), { metadata: {}, body: "Body" });
  assert.deepEqual(splitFrontmatter("No frontmatter"), { metadata: {}, body: "No frontmatter" });
});

test("renders disabled priorities by deterministic path", () => {
  assert.equal(renderManifests([{
    name: "notes",
    description: "Read notes.",
    documents: [document("z.md", { description: "Z", priority: "broken" }), document("a.md", { description: "A", priority: "p1" })],
  }]), [
    SHARED_MEMORY_PREAMBLE, "", "## Notes", "", "Read notes.", "", "Directory: `.agents/docs/notes/`", "",
    "- `a.md`: \"A\"", "- `z.md`: \"Z\"",
  ].join("\n"));
});

test("deeply nested filename braces cannot exhaust the scanner stack", () => {
  const pattern = "{".repeat(3500) + "a,b" + "}".repeat(3500);
  const output = renderManifests([{
    name: "notes",
    description: "Read notes.",
    documents: [document("a.md", { description: "Read this note." })],
    validation: { frontmatter: new Map(), requiredSections: [], filenamePattern: pattern },
  }]);
  assert.match(output!, /filename-mismatch/);
});

test("renders priority groups and stable escaped diagnostics", () => {
  const output = renderManifests([{
    name: "features",
    description: "Read features.",
    priorities: true,
    documents: [
      document("missing.md", {}),
      document("broken.md", { description: "Broken", priority: "x\n# heading" }),
      document("later.md", { description: "Later", priority: "p10" }),
      document("first.md", { description: "First", priority: "p01" }),
    ],
  }])!;
  assert.match(output, /- \(error\) `broken\.md`: "Broken"/);
  assert.match(output, /- \(p01\) `first\.md`/);
  assert.match(output, /- \(p10\) `later\.md`/);
  assert.match(output, /- \(np\) `missing\.md`: "missing description"/);
  assert.match(output, /- \(error\) `\.agents\/docs\/features\/broken\.md` \(invalid-priority\): `"x\\n# heading"`/);
  assert.match(output, /\(missing-description\): `"description is required"`/);
});

test("renders declared display fields after priority and validates displayed values", () => {
  const output = renderManifests([{
    name: "features",
    description: "Read features.",
    priorities: true,
    displayFields: ["status", "keywords"],
    validation: {
      frontmatter: new Map([
        ["status", { type: "enum", values: ["active", "[unsafe](x)\n## injected"] }],
        ["keywords", { type: "string[]" }],
      ]),
      requiredSections: [],
    },
    documents: [
      document("valid.md", { description: "Valid", priority: "p1", status: "active", keywords: ["one", "two"] }),
      document("missing.md", { description: "Missing", priority: "p2", keywords: ["one"] }),
      document("invalid.md", { description: "Invalid", priority: "p3", status: "wrong", keywords: ["one"] }),
      document("escaped.md", { description: "Escaped", priority: "p4", status: "[unsafe](x)\n## injected", keywords: ["one"] }),
    ],
  }])!;
  assert.match(output, /- \(p1\) \(active\) \(one, two\) `valid\.md`/);
  assert.match(output, /- \(p2\) \(one\) `missing\.md`/);
  assert.match(output, /- \(p3\) \(error\) \(one\) `invalid\.md`/);
  assert.match(output, /- \(p4\) \(\\\[unsafe\\\]\(x\)\\n## injected\) \(one\) `escaped\.md`/);
  assert.match(output, /invalid\.md` \(invalid-frontmatter\): `"status must be enum"`/);
  assert.doesNotMatch(output, /\n## injected/);
});

test("diagnoses invalid, unknown, and duplicate display-field declarations", async () => {
  const cwd = await fixture(async (docs) => {
    await mkdir(join(docs, "declarations"), { recursive: true });
    await mkdir(join(docs, "malformed"), { recursive: true });
    await writeFile(join(docs, "DECLARATIONS.md"), [
      "---", "doc-manifest:", "  version: 1", "  display-fields: [status, unknown, status]", "  validation:", "    frontmatter:", "      status:", "        type: enum", "        values: [ready]", "---", "Guide.",
    ].join("\n"));
    await writeFile(join(docs, "declarations", "one.md"), "---\ndescription: One\nstatus: ready\n---\n");
    await writeFile(join(docs, "MALFORMED.md"), "---\ndoc-manifest:\n  version: 1\n  display-fields: status\n---\nGuide.\n");
    await writeFile(join(docs, "malformed", "one.md"), "---\ndescription: One\n---\n");
  });
  try {
    const output = await buildManifest(cwd) ?? "";
    assert.match(output, /DECLARATIONS\.md` \(unknown-display-field\): `"doc-manifest\.display-fields\.unknown"`/);
    assert.match(output, /DECLARATIONS\.md` \(duplicate-display-field\): `"doc-manifest\.display-fields\.status"`/);
    assert.match(output, /MALFORMED\.md` \(invalid-display-fields\): `"doc-manifest\.display-fields must be a string array"`/);
    assert.equal((output.match(/\(ready\)/g) ?? []).length, 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("requires and validates each category's declared project-local creator skill", async () => {
  const cwd = await fixture(async (docs) => {
    for (const category of ["valid", "missing", "invalid", "absent", "mismatch"]) await mkdir(join(docs, category), { recursive: true });
    await writeFile(join(docs, "VALID.md"), "---\ndoc-manifest:\n  creator-skill: doc-valid-creator\n---\nValid.");
    await writeFile(join(docs, "MISSING.md"), "Missing.");
    await writeFile(join(docs, "INVALID.md"), "---\ndoc-manifest:\n  creator-skill: ../unsafe\n---\nInvalid.");
    await writeFile(join(docs, "ABSENT.md"), "---\ndoc-manifest:\n  creator-skill: doc-absent-creator\n---\nAbsent.");
    await writeFile(join(docs, "MISMATCH.md"), "---\ndoc-manifest:\n  creator-skill: doc-mismatch-creator\n---\nMismatch.");
    const skills = join(docs, "..", "skills");
    await mkdir(join(skills, "doc-valid-creator"), { recursive: true });
    await mkdir(join(skills, "doc-mismatch-creator"), { recursive: true });
    await writeFile(join(skills, "doc-valid-creator", "SKILL.md"), "---\nname: doc-valid-creator\ndescription: Create valid documents.\n---\n# Valid\n");
    await writeFile(join(skills, "doc-mismatch-creator", "SKILL.md"), "---\nname: wrong-name\ndescription: Wrong.\n---\n# Wrong\n");
  });
  try {
    const output = await buildManifest(cwd) ?? "";
    assert.match(output, /## Valid[\s\S]*Creator skill: `doc-valid-creator`/);
    assert.doesNotMatch(output, /docs\/VALID\.md` \((?:missing|invalid)-creator-skill/);
    assert.match(output, /MISSING\.md` \(missing-creator-skill\)/);
    assert.match(output, /INVALID\.md` \(invalid-creator-skill\)/);
    assert.match(output, /ABSENT\.md` \(missing-creator-skill-file\)/);
    assert.match(output, /MISMATCH\.md` \(invalid-creator-skill-file\)/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("allows linked creator-skill ancestors but rejects linked skill files", async () => {
  const target = await mkdtemp(join(tmpdir(), "pi-doc-manifests-target-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-doc-manifests-link-"));
  const agents = join(target, ".agents");
  const skill = join(agents, "skills", "doc-feature-creator", "SKILL.md");
  try {
    await mkdir(join(agents, "docs", "features"), { recursive: true });
    await mkdir(join(agents, "skills", "doc-feature-creator"), { recursive: true });
    await writeFile(join(agents, "docs", "FEATURES.md"), "---\ndoc-manifest:\n  creator-skill: doc-feature-creator\n---\nFeatures.");
    await writeFile(skill, "---\nname: doc-feature-creator\ndescription: Create feature documents.\n---\n# Features\n");
    await symlink(agents, join(cwd, ".agents"), "junction");

    const linkedAncestorOutput = await buildManifest(cwd) ?? "";
    assert.doesNotMatch(linkedAncestorOutput, /FEATURES\.md` \(invalid-creator-skill-file\)/);

    const linkedFile = join(target, "linked-skill.md");
    await writeFile(linkedFile, "---\nname: doc-feature-creator\ndescription: Create feature documents.\n---\n# Features\n");
    await rm(skill);
    await symlink(linkedFile, skill);

    const linkedFileOutput = await buildManifest(cwd) ?? "";
    assert.match(linkedFileOutput, /FEATURES\.md` \(invalid-creator-skill-file\): `"\.agents\/skills\/doc-feature-creator\/SKILL\.md must be a regular file"`/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("uses UTF-8 bytewise ordering", () => {
  const output = renderManifests([{
    name: "notes",
    description: "Notes.",
    documents: [document("😀.md", { description: "Emoji" }), document("\uE000.md", { description: "Private" })],
  }])!;
  assert.ok(output.indexOf("\uE000.md") < output.indexOf("😀.md"));
});

test("validates frontmatter, exact H2 sections, and root glob matches", () => {
  const output = renderManifests([{
    name: "features",
    description: "Read features.",
    validation: {
      frontmatter: new Map([
        ["status", { type: "enum", values: ["backlog", "active"] }],
        ["keywords", { type: "string[]" }],
      ]),
      requiredSections: ["Goal", "Acceptance Criteria"],
      filenamePattern: "**/*.md",
    },
    documents: [
      document("root.md", { description: "Root", status: "backlog", keywords: ["one"] }, "## Goal\n\n## Acceptance Criteria\n"),
      document("nested/bad.MD", { description: "Bad", status: "done", keywords: [] }, "## goal\n"),
      document("skip.txt", { description: "Skip", status: "active", keywords: ["ok"] }, "## Goal\n## Acceptance Criteria\n"),
    ],
  }])!;
  assert.doesNotMatch(output, /root\.md` \(filename-mismatch\)/);
  assert.match(output, /nested\/bad\.MD` \(invalid-frontmatter\)/);
  assert.match(output, /nested\/bad\.MD` \(missing-section\): `"Goal"`/);
  assert.match(output, /skip\.txt` \(filename-mismatch\)/);
});

test("ignores fenced pseudo-headings and preserves hashes in exact H2 names", () => {
  const output = renderManifests([{
    name: "notes",
    description: "Notes.",
    validation: { frontmatter: new Map(), requiredSections: ["Goal", "C#"], filenamePattern: "**/*.md" },
    documents: [document("one.md", { description: "One" }, "````md\n```not-a-close\n## Goal\n````\n## C#\n")],
  }])!;
  assert.match(output, /\(missing-section\): `"Goal"`/);
  assert.doesNotMatch(output, /\(missing-section\): `"C#"`/);
});

test("scans paired folders recursively and excludes hidden paths and symlinks", async () => {
  const cwd = await fixture(async (docs) => {
    await mkdir(join(docs, "features", "nested", ".hidden"), { recursive: true });
    await writeFile(join(docs, "FEATURES.md"), "---\ndoc-manifest:\n  version: 1\n  priorities: true\n---\nFeature routing.\n");
    await writeFile(join(docs, "features", "root.md"), "---\ndescription: Root\npriority: p2\n---\n");
    await writeFile(join(docs, "features", "nested", "one.MD"), "---\ndescription: One\npriority: p1\n---\n");
    await writeFile(join(docs, "features", "nested", ".hidden", "no.md"), "---\ndescription: No\npriority: p1\n---\n");
    await symlink(join(docs, "features", "root.md"), join(docs, "features", "linked.md"));
  });
  try {
    const output = await buildManifest(cwd);
    assert.match(output ?? "", /Feature routing\./);
    assert.match(output ?? "", /`nested\/one\.MD`/);
    assert.doesNotMatch(output ?? "", /hidden|linked\.md/);
    assert.match(output ?? "", /\(p1\) `nested\/one\.MD`/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("reports malformed YAML, duplicate keys, declarations, and still applies valid rules", async () => {
  const cwd = await fixture(async (docs) => {
    await mkdir(join(docs, "features"), { recursive: true });
    await writeFile(join(docs, "FEATURES.md"), [
      "---", "doc-manifest:", "  version: 1", "  priorities: true", "  unknown: true", "  validation:", "    unknown: true",
      "    frontmatter:", "      status:", "        type: enum", "        values: [backlog]", "        extra: true", "      nope: wrong",
      "      any:", "        type: any", "      enums:", "        type: enum[]", "      empty:", "        type: enum", "        values: ['   ']",
      "    required-sections: [Goal, 2]", "    filename-pattern: 3", "---", "Guide.",
    ].join("\n"));
    await writeFile(join(docs, "features", "bad.md"), "---\ndescription: One\ndescription: Two\nstatus: nope\npriority: urgent\n---\n# not H2\n");
  });
  try {
    const output = await buildManifest(cwd) ?? "";
    for (const code of ["unknown-declaration-key", "unknown-validation-key", "unknown-frontmatter-rule-key", "invalid-frontmatter-rule", "invalid-required-section", "invalid-filename-pattern", "malformed-frontmatter", "invalid-frontmatter", "missing-section"]) {
      assert.match(output, new RegExp(`\\(${code}\\)`));
    }
    assert.match(output, /- \(np\) `bad\.md`: "missing description"/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("uses one live declaration schema, ignores legacy versions, and retains malformed-guide fallback", async () => {
  const cwd = await fixture(async (docs) => {
    await mkdir(join(docs, "legacy"), { recursive: true });
    await mkdir(join(docs, "unversioned"), { recursive: true });
    await mkdir(join(docs, "broken"), { recursive: true });
    await writeFile(join(docs, "LEGACY.md"), "---\ndoc-manifest:\n  version: 2\n  priorities: true\n---\nLegacy guide.");
    await writeFile(join(docs, "legacy", "one.md"), "---\ndescription: One\npriority: invalid\n---\n");
    await writeFile(join(docs, "UNVERSIONED.md"), "---\ndoc-manifest:\n  priorities: true\n---\nUnversioned guide.");
    await writeFile(join(docs, "unversioned", "one.md"), "---\ndescription: One\npriority: invalid\n---\n");
    await writeFile(join(docs, "BROKEN.md"), "---\ndescription: unterminated");
    await writeFile(join(docs, "broken", "one.md"), "---\ndescription: One\n---\n");
  });
  try {
    const output = await buildManifest(cwd) ?? "";
    assert.match(output, /## Legacy[\s\S]*- \(error\) `one\.md`: "One"/);
    assert.match(output, /## Unversioned[\s\S]*- \(error\) `one\.md`: "One"/);
    assert.match(output, /## Broken/);
    assert.match(output, /Manifest description unavailable/);
    assert.match(output, /BROKEN\.md` \(malformed-frontmatter\)/);
    assert.doesNotMatch(output, /unsupported-version/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("reports structural root errors and does not list unpaired folder documents", async () => {
  const cwd = await fixture(async (docs) => {
    await mkdir(join(docs, "paired"), { recursive: true });
    await mkdir(join(docs, "loose"), { recursive: true });
    await mkdir(join(docs, "symlinked"), { recursive: true });
    await mkdir(join(docs, "wrongcase"), { recursive: true });
    await writeFile(join(docs, "PAIRED.md"), "Guide.");
    await writeFile(join(docs, "paired", "one.md"), "---\ndescription: One\n---\n");
    await writeFile(join(docs, "loose", "hidden.md"), "---\ndescription: Hidden\n---\n");
    await writeFile(join(docs, "README.md"), "Unexpected.");
    await writeFile(join(docs, "loose.md"), "Unexpected.");
    await writeFile(join(docs, "ORPHAN.md"), "Orphan.");
    await writeFile(join(docs, "WRONGCASE.MD"), "Wrong case.");
    await writeFile(join(docs, "wrongcase", "not-listed.md"), "---\ndescription: No\n---\n");
    const guide = join(docs, "..", "..", "guide.md");
    await writeFile(guide, "Guide.");
    await symlink(guide, join(docs, "SYMLINKED.md"));
    await writeFile(join(docs, "symlinked", "not-listed.md"), "---\ndescription: No\n---\n");
  });
  try {
    const output = await buildManifest(cwd) ?? "";
    assert.match(output, /## Paired/);
    assert.doesNotMatch(output, /not-listed\.md|hidden\.md/);
    assert.match(output, /README\.md` \(orphan-manifest\)/);
    assert.match(output, /loose\.md` \(unexpected-root-markdown\)/);
    assert.match(output, /ORPHAN\.md` \(orphan-manifest\)/);
    assert.match(output, /loose` \(unpaired-folder\)/);
    assert.match(output, /symlinked` \(unpaired-folder\)/);
    assert.match(output, /wrongcase` \(unpaired-folder\)/);
    assert.match(output, /WRONGCASE\.MD` \(orphan-manifest\)/);
    assert.doesNotMatch(output, /SYMLINKED\.md` \(orphan-manifest\)/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("diagnoses an empty manifest body and a non-directory docs root", async () => {
  const empty = await fixture(async (docs) => {
    await mkdir(join(docs, "notes"), { recursive: true });
    await writeFile(join(docs, "NOTES.md"), "---\ndoc-manifest:\n  version: 1\n---\n");
  });
  const invalid = await mkdtemp(join(tmpdir(), "pi-doc-manifests-"));
  try {
    assert.match(await buildManifest(empty) ?? "", /NOTES\.md` \(missing-manifest-description\)/);
    await mkdir(join(invalid, ".agents"), { recursive: true });
    await writeFile(join(invalid, ".agents", "docs"), "not a directory");
    const diagnosticsOnly = await buildManifest(invalid) ?? "";
    assert.ok(diagnosticsOnly.startsWith(`${SHARED_MEMORY_PREAMBLE}\n\n## Diagnostics\n\n`));
    assert.match(diagnosticsOnly, /\.agents\/docs\/` \(invalid-docs-root\)/);
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(invalid, { recursive: true, force: true });
  }
});

test("escapes diagnostic paths and details", () => {
  const output = renderManifests([{
    name: "notes",
    description: "Notes.",
    priorities: true,
    documents: [document("bad`\nname.md", { description: "Bad", priority: "x`\n## injected" })],
  }])!;
  assert.match(output, /bad`\\nname\.md/);
  assert.match(output, /x`\\n## injected/);
  assert.doesNotMatch(output, /\n## injected/);
});

test("does nothing when the documentation root is absent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-doc-manifests-"));
  try { assert.equal(await buildManifest(cwd), undefined); }
  finally { await rm(cwd, { recursive: true, force: true }); }
});
