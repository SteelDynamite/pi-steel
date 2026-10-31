import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { initializeProject } from "./src/init";
import { buildManifest } from "./src/manifest";

type Snapshot = { content: string };

function snapshotFromBranch(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== "doc-manifests") continue;
    const data = entry.data as Partial<Snapshot> | undefined;
    if (typeof data?.content === "string") return data.content;
  }
  return undefined;
}

function manifestForPrompt(content: string): string {
  const escaped = content.replace(/<\/?docs-manifest(?=[\s/>])/g, (tag) => `&lt;${tag.slice(1)}`);
  return `<docs-manifest>\n${escaped}\n</docs-manifest>`;
}

export default function (pi: ExtensionAPI) {
  let snapshot: string | undefined;

  pi.registerEntryRenderer<Snapshot>("doc-manifests", (entry, _options, theme) => {
    if (typeof entry.data?.content !== "string") return undefined;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m[doc-manifests]\x1b[22m"), 0, 0));
    box.addChild(new Spacer(1));
    box.addChild(new Markdown(entry.data.content, 0, 0, getMarkdownTheme(), {
      color: (text) => theme.fg("customMessageText", text),
    }));
    return box;
  });

  const restoreOrCreate = async (ctx: ExtensionContext, rebuild = false) => {
    snapshot = undefined;
    if (!ctx.isProjectTrusted()) return;
    if (!rebuild) {
      snapshot = snapshotFromBranch(ctx.sessionManager.getBranch());
      if (snapshot !== undefined) return;
    }
    snapshot = await buildManifest(ctx.cwd);
    if (snapshot !== undefined) pi.appendEntry("doc-manifests", { content: snapshot } satisfies Snapshot);
  };

  pi.registerCommand("doc-manifests", {
    description: "Initialize shared project documentation (usage: /doc-manifests init)",
    handler: async (args, ctx) => {
      if (args.trim() !== "init") {
        ctx.ui.notify("Usage: /doc-manifests init", "warning");
        return;
      }
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Refused: /doc-manifests init requires a trusted project.", "warning");
        return;
      }
      const result = await initializeProject(ctx.cwd);
      if (!result.ok) {
        ctx.ui.notify(result.message, "warning");
        return;
      }
      await restoreOrCreate(ctx, true);
      ctx.ui.notify("Initialized example .agents/docs categories and project-local doc-* skills. Start a new Pi session to load the project skills.", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await restoreOrCreate(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreOrCreate(ctx);
  });

  pi.on("before_agent_start", (event) => {
    if (snapshot === undefined) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${manifestForPrompt(snapshot)}` };
  });
}
