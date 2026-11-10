import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index";
import { SHARED_MEMORY_PREAMBLE } from "../src/manifest";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-doc-manifests-"));
  const docs = join(cwd, ".agents", "docs");
  await mkdir(join(docs, "policies"), { recursive: true });
  await mkdir(join(cwd, ".agents/skills/doc-policy-creator"), { recursive: true });
  await writeFile(join(docs, "POLICIES.md"), "---\ndoc-manifest:\n  creator-skill: doc-policy-creator\n---\nGuidance.");
  await writeFile(join(docs, "policies/one.md"), "---\ndescription: One\n---\n");
  await writeFile(join(cwd, ".agents/skills/doc-policy-creator/SKILL.md"), "---\nname: doc-policy-creator\ndescription: Create policies.\n---\n# Policies\n");
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const branch: any[] = [];
  const appended: any[] = [];
  let renderer: any;
  extension({
    on(name: string, handler: any) { handlers.set(name, handler); },
    appendEntry(customType: string, data: unknown) {
      const entry = { type: "custom", customType, data };
      branch.push(entry); appended.push(entry);
    },
    registerEntryRenderer(_name: string, value: any) { renderer = value; },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  const ctx = { cwd, isProjectTrusted: () => true, sessionManager: { getBranch: () => branch } };
  const request = async (messages: any[] = [{ role: "system", content: "Base", timestamp: 1 }], context = ctx) =>
    (await handlers.get("context_with_system")!({ messages }, context)).messages;
  return { cwd, docs, handlers, branch, appended, renderer, ctx, request, close: () => rm(cwd, { recursive: true, force: true }) };
}

test("lifecycle records current disk content without restoring stale snapshots or duplicating unchanged entries", async () => {
  const f = await fixture();
  try {
    await f.handlers.get("session_start")!({}, { ...f.ctx, isProjectTrusted: () => false });
    assert.equal(f.appended.length, 0);
    f.branch.push({ type: "custom", customType: "doc-manifests", data: { version: 1, content: "Obsolete" } });
    await f.handlers.get("session_start")!({}, f.ctx);
    assert.equal(f.appended.length, 1);
    const content = f.appended[0].data.content;
    assert(content.startsWith(`${SHARED_MEMORY_PREAMBLE}\n\n## Policies`));
    assert(!content.includes("Obsolete"));
    assert.deepEqual(Object.keys(f.appended[0].data), ["content"]);
    for (const reason of ["reload", "resume", "fork"]) await f.handlers.get("session_start")!({ reason }, f.ctx);
    f.branch.push({ type: "compaction" });
    await f.handlers.get("session_tree")!({}, f.ctx);
    assert.equal(f.appended.length, 1);
    await writeFile(join(f.docs, "policies/one.md"), "---\ndescription: Changed\n---\n");
    await f.handlers.get("session_start")!({ reason: "reload" }, f.ctx);
    assert.equal(f.appended.length, 2);
    assert.match(f.appended[1].data.content, /Changed/);
    assert(!f.handlers.has("before_agent_start"));
  } finally { await f.close(); }
});

test("every request sees edits, additions and deletions while preserving all other system and tool state", async () => {
  const f = await fixture();
  try {
    const messages: any[] = [
      { role: "system", content: [{ type: "text", text: "Base" }], timestamp: 1, sections: { other: "Other", pi_doc_manifests: "Stale" }, toolsAdded: [{ name: "read" }] },
      { role: "user", content: "Question", timestamp: 2 },
      { role: "system", content: "Later", timestamp: 3, sections: { another: "Keep", pi_doc_manifests: "Later stale" }, toolsRemoved: [{ name: "write" }] },
    ];
    const original = structuredClone(messages);
    const first = await f.request(messages);
    assert.match(first[0].sections.pi_doc_manifests, /One/);
    assert.equal(first[0].sections.other, "Other");
    assert.deepEqual(first[0].content, messages[0].content);
    assert.deepEqual(first[0].toolsAdded, messages[0].toolsAdded);
    assert.deepEqual(first[2], { ...messages[2], sections: { another: "Keep" } });
    assert.strictEqual(first[1], messages[1]);
    assert.deepEqual(messages, original);
    await writeFile(join(f.docs, "policies/two.md"), "---\ndescription: Second\n---\n");
    await writeFile(join(f.docs, "policies/one.md"), "---\ndescription: Updated\n---\n");
    assert.match((await f.request(first))[0].sections.pi_doc_manifests, /Updated[\s\S]*Second/);
    await rm(join(f.docs, "policies/one.md"));
    assert(!((await f.request(first))[0].sections.pi_doc_manifests).includes("one.md"));
    const untrusted = await f.request(first, { ...f.ctx, isProjectTrusted: () => false });
    assert.equal(untrusted[0].sections.pi_doc_manifests, undefined);
    assert.equal(untrusted[2].sections.pi_doc_manifests, undefined);
    await rm(f.docs, { recursive: true });
    assert.equal((await f.request(first))[0].sections.pi_doc_manifests, undefined);
    assert.equal(f.appended.length, 0, "request refreshes must not write history");
    await mkdir(f.docs);
    assert.equal((await f.request())[0].sections.pi_doc_manifests, undefined);
  } finally { await f.close(); }
});

test("request failures replace stale guidance with a diagnostic and recover on the next request", async () => {
  const f = await fixture();
  try {
    const previous = await f.request();
    await writeFile(join(f.docs, "POLICIES.md"), `---\ndoc-manifest:\n  creator-skill: doc-policy-creator\n  validation:\n    filename-pattern: ${"a".repeat(65537)}\n---\nGuidance.\n`);
    const failed = (await f.request(previous))[0].sections.pi_doc_manifests;
    assert.match(failed, /Manifest refresh failed.*pattern is too long/);
    assert(!failed.includes("one.md"));
    await writeFile(join(f.docs, "POLICIES.md"), "---\ndoc-manifest:\n  creator-skill: doc-policy-creator\n---\nGuidance.");
    assert.match((await f.request())[0].sections.pi_doc_manifests, /one.md/);
    assert.equal(f.appended.length, 0);
  } finally { await f.close(); }
});

test("authored wrapper tags are escaped, while legacy display entries still render as Markdown", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.docs, "policies/one.md"), '---\ndescription: Before <docs-manifest/> <docs-manifest source="authored">inside</docs-manifest > after\n---\n');
    const prompt = (await f.request())[0].sections.pi_doc_manifests;
    assert.equal((prompt.match(/<docs-manifest>/g) ?? []).length, 1);
    assert.equal((prompt.match(/<\/docs-manifest>/g) ?? []).length, 1);
    assert.match(prompt, /&lt;docs-manifest\//);
    const styles: string[] = [];
    const theme = { bg(name: string, text: string) { styles.push(name); return text; }, fg(name: string, text: string) { styles.push(name); return text; } };
    initTheme(undefined, false);
    const component = f.renderer({ data: { version: 1, content: "## Legacy\nDisplay only." } }, {}, theme);
    assert.match(component.render(120).join("\n"), /\[doc-manifests\][\s\S]*Legacy/);
    assert.deepEqual(new Set(styles), new Set(["customMessageBg", "customMessageLabel", "customMessageText"]));
    assert.equal(f.renderer({ data: { version: 1 } }, {}, theme), undefined);
  } finally { await f.close(); }
});
