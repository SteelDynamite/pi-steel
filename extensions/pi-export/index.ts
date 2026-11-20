import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
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

const parameters = Type.Object({ format: StringEnum(["html", "jsonl"] as const) }, { additionalProperties: false });

export const exportSession = defineTool<typeof parameters, { format: "html" | "jsonl"; path: string }>({
  name: "export_session",
  label: "Export session",
  description: "Save a fresh local snapshot of this session when the user requests an export. HTML includes all saved branches; JSONL includes only the current branch. Returns the file path; does not upload or redact content.",
  promptSnippet: "Export this session locally as HTML or JSONL",
  parameters,
  async execute(_id, { format }, signal, _onUpdate, ctx) {
    signal?.throwIfAborted();
    if (format !== "html" && format !== "jsonl") throw new Error("Expected format html or jsonl.");
    const sm = ctx.sessionManager;
    const file = sm.getSessionFile();
    if (format === "html" && !file) throw new Error("HTML needs a saved Pi session. Use JSONL for an in-memory session.");
    const directory = await mkdtemp(join(ctx.cwd, "pi-export-"));
    const path = join(directory, `session.${format}`);
    try {
      if (format === "html") {
        await writeFile(path, "", { flag: "wx", mode: 0o600 });
        await exportHtml(file!, path, signal);
      } else {
        // Like /export, stamp a new header and link only the exported branch, not the fork's source file.
        const header = { type: "session", version: CURRENT_SESSION_VERSION, id: sm.getSessionId(), timestamp: new Date().toISOString(), cwd: sm.getCwd() };
        const lines = [JSON.stringify(header)];
        let parentId: string | null = null;
        for (const entry of sm.getBranch()) {
          lines.push(JSON.stringify({ ...entry, parentId }));
          parentId = entry.id;
        }
        await writeFile(path, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600, signal });
      }
      signal?.throwIfAborted();
      return { content: [{ type: "text", text: path }], details: { format, path } };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(exportSession);
}
