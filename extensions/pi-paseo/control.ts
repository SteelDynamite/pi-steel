import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const commands = [
  "ls", "inspect", "run", "send", "stop", "workspace ls", "provider ls",
  "terminal ls", "terminal create", "terminal capture", "terminal send-keys", "terminal kill",
] as const;

export const controlSchema = Type.Object({
  // Pi 1.5's StringEnum carries pi-schema rather than TypeBox static metadata.
  command: Type.Unsafe<(typeof commands)[number]>(StringEnum(commands)),
  agentId: Type.Optional(Type.String({ description: "Full UUID from ls; never a prefix or name." })),
  workspaceId: Type.Optional(Type.String({ description: "Full wks_ ID from workspace ls." })),
  terminalId: Type.Optional(Type.String({ description: "Full UUID from terminal ls; never a prefix or name." })),
  provider: Type.Optional(Type.String({ description: "Provider ID from provider ls (run only)." })),
  prompt: Type.Optional(Type.String({ description: "Task for run or follow-up for send." })),
  name: Type.Optional(Type.String({ description: "Terminal name (terminal create only)." })),
  keys: Type.Optional(Type.Array(Type.String(), { description: "Terminal input; literal=false interprets tokens such as Enter." })),
  literal: Type.Optional(Type.Boolean({ description: "Required for terminal send-keys: true sends raw text; false interprets key tokens." })),
}, { additionalProperties: false });

export type ControlInput = Static<typeof controlSchema>;

const required: Record<ControlInput["command"], readonly (keyof ControlInput)[]> = {
  ls: [], inspect: ["agentId"], run: ["workspaceId", "provider", "prompt"],
  send: ["agentId", "prompt"], stop: ["agentId"], "workspace ls": [], "provider ls": [],
  "terminal ls": [], "terminal create": ["workspaceId", "name"],
  "terminal capture": ["terminalId"], "terminal send-keys": ["terminalId", "keys", "literal"],
  "terminal kill": ["terminalId"],
};
const mutations = new Set<ControlInput["command"]>(["run", "send", "stop", "terminal create", "terminal send-keys", "terminal kill"]);
// Paseo 0.15.3 uses UUIDs for agents/terminals, but workspace-registry-model.ts
// generates wks_ + 16 hex digits. CLI prefixes/names are deliberately excluded.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CLI-only adapter; registration/activation and settings belong to the caller.
 * Contracts: Paseo 0.15.3 public-docs/cli.md and packages/cli/src/commands/.
 * run/send must use --no-wait; send explicitly steers rather than interrupts.
 * cli.ts registers top-level agent aliases; send accepts --prompt, while run
 * takes a positional prompt. --json selects structured CLI output, not prompts.
 * Native execFile bounds both streams and hard-kills on timeout: Pi 1.4 exec
 * cannot enforce capture limits. Preserve caller identity, including PASEO_AGENT_ID.
 */
export async function executeControl(
  params: ControlInput,
  signal: AbortSignal | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  // Redact before truncation, including errors. No invocation or raw output is
  // retained in details. CLI output remains untrusted and may contain secrets.
  const secrets = Object.entries(env)
    .filter(([key, value]) => value && (/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)/i.test(key) || key === "PASEO_HOST"))
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
  const sanitize = (text: string) => {
    for (const secret of secrets) {
      text = text.split(secret).join("[REDACTED]");
      for (const encoded of [encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) {
        if (encoded !== secret) text = text.split(encoded).join("[REDACTED]");
      }
    }
    return text
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1[REDACTED]@")
      .replace(/([?&](?:password|token|secret|api[_-]?key|auth|credential)=)[^\s&#"']*/gi, "$1[REDACTED]");
  };
  const result = (text: string, isError = false) => {
    const truncated = truncateHead(sanitize(text), { maxBytes: 50 * 1024, maxLines: 2000 });
    return {
      content: [{ type: "text" as const, text: truncated.content + (truncated.truncated
        ? "\n[Output truncated at 50 KiB/2000 lines; remainder discarded, not saved.]" : "") }],
      details: { truncated: truncated.truncated },
      ...(isError ? { isError: true } : {}),
    };
  };
  if (!params || typeof params !== "object" || !commands.includes(params.command)) return result("Unsupported Paseo command.", true);
  const fields = required[params.command];
  if (Object.keys(params).some((key) => key !== "command" && !fields.includes(key as keyof ControlInput))) {
    return result("Irrelevant parameter for this Paseo command.", true);
  }
  for (const field of fields) {
    const value = params[field];
    if (field === "literal") {
      if (typeof value !== "boolean") return result("literal must be a boolean.", true);
    } else if (field === "keys") {
      if (!Array.isArray(value) || value.length === 0 || value.some((key) => typeof key !== "string" || !key || key.includes("\0"))) {
        return result("keys must be a nonempty array of nonempty strings without NUL.", true);
      }
    } else {
      if (typeof value !== "string" || !value.trim() || value.includes("\0")) return result(`${field} is required and must be nonempty text without NUL.`, true);
      if (field.endsWith("Id") && !(field === "workspaceId" ? /^wks_[0-9a-f]{16}$/.test(value) : uuid.test(value))) {
        return result(`${field} must be a full ID copied from the corresponding list output (agents/terminals: UUID; workspaces: wks_ plus 16 hex digits).`, true);
      }
    }
  }
  const home = env.PASEO_HOME;
  const host = env.PASEO_HOST;
  if (Number(Boolean(home)) + Number(Boolean(host)) !== 1) return result("Set exactly one inherited PASEO_HOME or PASEO_HOST before using Paseo.", true);
  const target = home ?? host!;
  if (!target.trim() || target.includes("\0")) return result("Invalid inherited Paseo target.", true);
  const executable = env.PASEO_HOOK_CLI ?? "paseo";
  if (env.PASEO_HOOK_CLI !== undefined && (!isAbsolute(executable) || executable.includes("\0"))) {
    return result("PASEO_HOOK_CLI must be an absolute executable path.", true);
  }
  if (signal?.aborted) return result("Paseo request canceled before execution; nothing was submitted.", true);

  // Explicit flags override any CLI defaults without changing the inherited env.
  // '=' prevents values beginning with '-' from becoming options. '--' protects
  // prompts/keys; no model text becomes a CLI option or shell program.
  const args = [home ? `--home=${home}` : `--host=${host}`];
  switch (params.command) {
    case "ls": args.push("ls", "--global", "--json"); break;
    case "inspect": args.push("inspect", "--json", "--", params.agentId!); break;
    case "run": args.push("run", "--json", "--no-wait", "--env=PI_ORCHESTRATED_CHILD=1", `--workspace=${params.workspaceId}`, `--provider=${params.provider}`, "--", params.prompt!); break;
    case "send": args.push("send", "--json", "--no-wait", "--behavior=steer", `--prompt=${params.prompt}`, "--", params.agentId!); break;
    case "stop": args.push("stop", "--json", "--", params.agentId!); break;
    case "workspace ls": args.push("workspace", "ls", "--json"); break;
    case "provider ls": args.push("provider", "ls", "--json"); break;
    case "terminal ls": args.push("terminal", "ls", "--all", "--json"); break;
    case "terminal create": args.push("terminal", "create", "--json", `--workspace=${params.workspaceId}`, `--name=${params.name}`); break;
    case "terminal capture": args.push("terminal", "capture", "--json", "--", params.terminalId!); break;
    case "terminal send-keys": args.push("terminal", "send-keys", "--json", ...(params.literal ? ["--literal"] : []), "--", params.terminalId!, ...params.keys!); break;
    case "terminal kill": args.push("terminal", "kill", "--json", "--", params.terminalId!); break;
  }
  const uncertain = mutations.has(params.command)
    ? " Mutation outcome may be unknown; inspect/list before deciding what to do. Do not blindly retry."
    : "";
  return await new Promise<ReturnType<typeof result>>((resolve) => {
    try {
      const child = execFile(executable, args, {
        signal, cwd, env, shell: false, encoding: "utf8", timeout: 30_000,
        maxBuffer: 1024 * 1024, killSignal: "SIGKILL",
      }, (error, stdout, stderr) => {
        const failed = Boolean(error) || Boolean(signal?.aborted);
        // Never expose error.message: execFile embeds the entire invocation.
        const code = error?.code;
        let status = failed ? `Paseo failed (exit ${typeof code === "number" ? code : "unavailable"}).` : "Paseo completed.";
        if (signal?.aborted) status += " CLI canceled.";
        else if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") status += " Capture truncated at 1 MiB per stream; remainder discarded.";
        else if (error?.killed) status += " CLI timed out or terminated.";
        if (failed) status += uncertain;
        // A bounded prefix may be incomplete JSON; retain IDs without parsing.
        resolve(result(`${status}\n${stdout}${stderr ? `\nCLI stderr:\n${stderr}` : ""}`, failed));
      });
      // Node execFile does not forward killSignal to spawn's AbortSignal path.
      // Its abort callback can run before exit, so retain this listener until close.
      const abort = () => { child.kill("SIGKILL"); };
      signal?.addEventListener("abort", abort, { once: true });
      child.once("close", () => signal?.removeEventListener("abort", abort));
      if (signal?.aborted) abort();
      child.stdin?.end();
    } catch {
      // Synchronous spawn/option failures may also contain invocation details.
      resolve(result(`Paseo execution failed.${uncertain}`, true));
    }
  });
}
