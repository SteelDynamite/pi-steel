import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { zip } from "fflate";
import { StringEnum } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION, defineTool, getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

async function exportHtml(sessionFile: string, output: string, signal?: AbortSignal) {
  // SDK hosts need not be the Pi CLI. Use the hosting distribution, not argv[1] or PATH.
  const root = getPackageDir();
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const args = ["--offline", "--export", sessionFile, output];
  if (pkg.name !== "@earendil-works/pi-coding-agent" || typeof pkg.bin?.pi !== "string" || !pkg.bin.pi) {
    throw new Error("HTML export requires the hosting Pi CLI package.");
  }
  if (/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) {
    args.unshift(resolve(root, pkg.bin.pi));
  } else if (!process.versions.bun || await realpath(process.execPath) !== await realpath(join(root, process.platform === "win32" ? "pi.exe" : "pi"))) {
    throw new Error("HTML export requires a Node.js or Bun Pi installation.");
  }
  await promisify(execFile)(process.execPath, args, { cwd: root, signal });
}

const parameters = Type.Object({ format: Type.Optional(StringEnum(["html", "jsonl"] as const)) }, { additionalProperties: false });

export const exportSession = defineTool<typeof parameters, { format: "html" | "jsonl"; path: string; attached: boolean }>({
  name: "export_session",
  label: "Export session",
  description: "When the user requests an export, create a ZIP and attach it to this MausBot chat. Default: Pi HTML viewer with all branches. Request jsonl for the current branch only. Content is unredacted. If attachment is unavailable, use the returned ZIP path; do not export again.",
  promptSnippet: "Export and attach this session as a ZIP (HTML by default)",
  parameters,
  async execute(_id, { format = "html" }, signal, _onUpdate, ctx) {
    signal?.throwIfAborted();
    if (format !== "html" && format !== "jsonl") throw new Error("Expected format html or jsonl.");
    const sm = ctx.sessionManager;
    const directory = await mkdtemp(join(ctx.cwd, "pi-export-"));
    const path = join(directory, `session-${format}.zip`);
    const snapshot = join(directory, "session.jsonl");
    const name = `session.${format}`;
    try {
      const freshHeader = { type: "session", version: CURRENT_SESSION_VERSION, id: sm.getSessionId(), timestamp: new Date().toISOString(), cwd: sm.getCwd() };
      const header = format === "html" ? sm.getHeader() ?? freshHeader : freshHeader;
      const lines = [JSON.stringify(header)];
      let parentId: string | null = null;
      for (const entry of format === "html" ? sm.getEntries() : sm.getBranch()) {
        lines.push(JSON.stringify(format === "html" ? entry : { ...entry, parentId }));
        parentId = entry.id;
      }
      let data: Uint8Array = Buffer.from(`${lines.join("\n")}\n`);
      if (format === "html") {
        const html = join(directory, name);
        await writeFile(snapshot, data, { flag: "wx", mode: 0o600, signal });
        await exportHtml(snapshot, html, signal);
        data = await readFile(html, { signal });
        await rm(snapshot);
        await rm(html);
      }
      const archive = await promisify(zip)({ [name]: data });
      await writeFile(path, archive, { flag: "wx", mode: 0o600, signal });
      signal?.throwIfAborted();
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }

    // Delivery is separate from generation: a failed or unavailable chat bridge must not lose the ZIP.
    const attachment = "agents_attach_file";
    const details = { format, path, attached: false } as const;
    if (!ctx.tools?.some(tool => tool.name === attachment)) {
      return { content: [{ type: "text", text: `ZIP saved at ${path}. Attachment unavailable inside export_session. If ${attachment} is available directly, attach this ZIP without regenerating it.` }], details };
    }
    try {
      const outcome = await ctx.executeTool(attachment, { path }, { signal });
      if (outcome.isError) throw new Error(outcome.result.content.filter(block => block.type === "text").map(block => block.text).join("\n") || "Attachment declined.");
      return { content: [{ type: "text", text: `Attached ${path}` }, ...outcome.result.content], details: { ...details, attached: true } };
    } catch (error) {
      signal?.throwIfAborted();
      return { content: [{ type: "text", text: `ZIP saved at ${path}. Attachment failed: ${error instanceof Error ? error.message : String(error)}` }], details };
    }
  },
});

export default function (pi: ExtensionAPI) {
  if (process.env.OMB_MCP_CONFIG?.trim()) pi.registerTool(exportSession);
}
