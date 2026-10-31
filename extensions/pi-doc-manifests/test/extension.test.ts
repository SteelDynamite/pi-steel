import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index";
import { SHARED_MEMORY_PREAMBLE } from "../src/manifest";

type Entry = { type: string; customType?: string; data?: unknown };

async function docsFixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-doc-manifests-"));
  const docs = join(cwd, ".agents", "docs");
  await mkdir(join(docs, "policies"), { recursive: true });
  await mkdir(join(cwd, ".agents", "skills", "doc-policy-creator"), { recursive: true });
  await writeFile(join(docs, "POLICIES.md"), "---\ndoc-manifest:\n  creator-skill: doc-policy-creator\n---\nGuidance.");
  await writeFile(join(docs, "policies", "one.md"), "---\ndescription: One\n---\n");
  await writeFile(join(cwd, ".agents", "skills", "doc-policy-creator", "SKILL.md"), "---\nname: doc-policy-creator\ndescription: Create policy documents.\n---\n# Policies\n");
  return cwd;
}

test("persists, restores, renders, and injects snapshots by active branch", async () => {
  const cwd = await docsFixture();
  try {
    const handlers = new Map<string, (event: any, ctx: any) => any>();
    const appended: Array<{ type: string; data: unknown }> = [];
    let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
    extension({
      on(event: string, handler: (event: any, ctx: any) => any) { handlers.set(event, handler); },
      appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
      registerEntryRenderer(_type: string, value: (entry: any, options: any, theme: any) => any) { renderer = value; },
      registerCommand() {},
    } as unknown as ExtensionAPI);

    let branch: Entry[] = [];
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      sessionManager: { getBranch: () => branch },
    };
    await handlers.get("session_start")?.({}, { ...ctx, isProjectTrusted: () => false });
    assert.equal(appended.length, 0);

    await handlers.get("session_start")?.({}, ctx);
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.type, "doc-manifests");
    const created = appended[0]?.data as { content: string };
    assert.deepEqual(Object.keys(created), ["content"]);
    assert.ok(created.content.startsWith(`${SHARED_MEMORY_PREAMBLE}\n\n## Policies`));
    assert.doesNotMatch(created.content, /<\/?docs-manifest/);
    const styles: string[] = [];
    const theme = {
      bg(name: string, text: string) { styles.push(name); return text; },
      fg(name: string, text: string) { styles.push(name); return text; },
    };
    const component = renderer?.({ data: created }, {}, theme);
    initTheme(undefined, false);
    const rendered = component.render(120).join("\n");
    assert.match(rendered, /\[doc-manifests\][\s\S]*Policies/);
    assert.doesNotMatch(rendered, /<\/?docs-manifest/);
    assert.deepEqual(new Set(styles), new Set(["customMessageBg", "customMessageLabel", "customMessageText"]));
    assert.deepEqual(handlers.get("before_agent_start")?.({ systemPrompt: "Base" }, ctx), {
      systemPrompt: `Base\n\n<docs-manifest>\n${created.content}\n</docs-manifest>`,
    });

    const authored = { version: 1, content: "Before <docs-manifest/> <docs-manifest source=\"authored\">inside</docs-manifest > after." };
    branch = [{ type: "custom", customType: "doc-manifests", data: authored }];
    await handlers.get("session_start")?.({ reason: "reload" }, ctx);
    assert.deepEqual(handlers.get("before_agent_start")?.({ systemPrompt: "Base" }, ctx), {
      systemPrompt: "Base\n\n<docs-manifest>\nBefore &lt;docs-manifest/> &lt;docs-manifest source=\"authored\">inside&lt;/docs-manifest > after.\n</docs-manifest>",
    });

    branch = [{ type: "custom", customType: "doc-manifests", data: { version: 1, content: "Older" } }, { type: "custom", customType: "doc-manifests", data: created }];
    for (const reason of ["reload", "resume", "fork"]) {
      await handlers.get("session_start")?.({ reason }, ctx);
    }
    assert.equal(appended.length, 1);
    assert.deepEqual(handlers.get("before_agent_start")?.({ systemPrompt: "Base" }, ctx), { systemPrompt: `Base\n\n<docs-manifest>\n${created.content}\n</docs-manifest>` });

    branch = [{ type: "custom", customType: "doc-manifests", data: created }, { type: "compaction" }];
    await handlers.get("session_start")?.({ reason: "reload" }, ctx);
    assert.equal(appended.length, 1);
    assert.deepEqual(handlers.get("before_agent_start")?.({ systemPrompt: "Base" }, ctx), { systemPrompt: `Base\n\n<docs-manifest>\n${created.content}\n</docs-manifest>` });

    branch = [];
    await handlers.get("session_tree")?.({}, ctx);
    assert.equal(appended.length, 2);
    assert.match((appended[1]?.data as { content: string }).content, /## Policies/);

    await handlers.get("session_tree")?.({}, { ...ctx, isProjectTrusted: () => false });
    assert.equal(handlers.get("before_agent_start")?.({ systemPrompt: "Base" }, ctx), undefined);
    assert.ok(renderer?.({ data: { version: 2, content: "Legacy version ignored" } }, {}, theme));
    assert.equal(renderer?.({ data: { version: 1 } }, {}, theme), undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("does not restore unsupported prototype custom messages", async () => {
  const cwd = await docsFixture();
  try {
    const handlers = new Map<string, (event: any, ctx: any) => any>();
    const appended: unknown[] = [];
    extension({
      on(event: string, handler: (event: any, ctx: any) => any) { handlers.set(event, handler); },
      appendEntry(_type: string, data: unknown) { appended.push(data); },
      registerEntryRenderer() {},
      registerCommand() {},
    } as unknown as ExtensionAPI);
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      sessionManager: { getBranch: () => [{ type: "custom_message", customType: "doc-manifests", content: "obsolete" }] },
    };
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(appended.length, 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("does not inject without a trusted tree or snapshot", async () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  extension({
    on(event: string, handler: (event: any, ctx: any) => any) { handlers.set(event, handler); },
    appendEntry() {},
    registerEntryRenderer() {},
    registerCommand() {},
  } as unknown as ExtensionAPI);
  const cwd = await mkdtemp(join(tmpdir(), "pi-doc-manifests-"));
  try {
    const ctx = { cwd, isProjectTrusted: () => true, sessionManager: { getBranch: () => [] } };
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(handlers.get("before_agent_start")?.({ systemPrompt: "Base" }, ctx), undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
