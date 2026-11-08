import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityConnection, ActivityReporter } from "./activity.js";
import { controlSchema, executeControl } from "./control.js";

export function readSettings(path: string): { tools?: boolean; [key: string]: unknown } {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot read pi-paseo settings.");
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (value.tools !== undefined && typeof value.tools !== "boolean")) throw new Error();
    return value;
  } catch { throw new Error("Invalid pi-paseo settings: expected an object with a boolean tools field."); }
}

export default function paseo(pi: ExtensionAPI) {
  // Inherited terminal credentials do not give children ownership of the parent
  // terminal indicator. Children also cannot recursively expose our control tool.
  if (process.env.PI_ORCHESTRATED_CHILD === "1") return;
  const env = { ...process.env };
  const inside = Boolean(env.PASEO_TERMINAL_ID || env.PASEO_AGENT_ID);
  const settingsPath = join(getAgentDir(), "paseo.json");
  let reporter: ActivityReporter | undefined;
  let waiting = false;
  let stopped = false;
  let toolsEnabled = false;
  let settingsError: string | undefined;
  let controlAbort = new AbortController();

  function registerControl() {
    pi.registerTool({
      name: "paseo_control", label: "Paseo", exposure: toolsEnabled && inside ? "direct" : "hidden",
      description: "Control this session's Paseo daemon. Commands and required fields: ls, workspace ls, provider ls, terminal ls: none; inspect/stop: agentId; run: workspaceId, provider, prompt; send: agentId, prompt; terminal create: workspaceId, name; terminal capture/kill: terminalId; terminal send-keys: terminalId, keys, literal. No other fields. Use full IDs from lists. run/send return before completion; inspect to check progress. Calls stop after 30 seconds; output capped at 50 KiB/2000 lines, capture at 1 MiB per stream. Discarded output is not saved.",
      promptSnippet: "Inspect and control Paseo agents, workspaces, and terminals",
      promptGuidelines: [
        "Use paseo_control only for requested Paseo operations. Terminal input can execute commands; obtain approval for destructive or unrelated operations.",
        "paseo_control run/send are asynchronous. Cancellation stops only the CLI, not remote agents or submitted work. Never automatically retry a mutation with uncertain outcome.",
      ],
      parameters: controlSchema,
      async execute(_id, params, signal, _update, ctx) {
        if (!toolsEnabled || !inside || stopped) throw new Error("pi-paseo control tools are disabled.");
        return executeControl(params, signal ? AbortSignal.any([signal, controlAbort.signal]) : controlAbort.signal, ctx.cwd, env);
      },
    });
  }

  function updateActivity(ctx: ExtensionContext) {
    if (!stopped) void reporter?.report(waiting ? "needs-input" : ctx.isIdle() ? "idle" : "running");
  }

  function status() {
    return [
      `Paseo: ${inside ? "detected" : "not detected"}.`,
      `Terminal activity: ${reporter ? reporter.error ?? "enabled (best effort)" : "inactive (requires a Paseo TUI and valid loopback endpoint)"}.`,
      `pi-paseo control tools: ${toolsEnabled ? inside ? "on" : "on in settings, inactive outside Paseo" : "off"}.`,
      "Paseo-injected tools are managed separately and are unchanged.",
      `Settings: ${settingsPath}`,
      ...(settingsError ? [settingsError] : []),
    ].join("\n");
  }

  pi.on("session_start", async (_event, ctx) => {
    try { toolsEnabled = readSettings(settingsPath).tools === true; }
    catch (error) {
      settingsError = (error as Error).message;
      toolsEnabled = false;
      ctx.ui.notify(settingsError, "warning");
    }
    registerControl();
    const connection = ctx.mode === "tui" ? activityConnection(env) : undefined;
    if (connection) {
      reporter = new ActivityReporter(connection);
      // Finish startup reset before work can begin, so even a fast first turn
      // produces running -> idle rather than being coalesced into startup idle.
      await reporter.report("idle");
    }
  });
  pi.on("before_agent_start", (_event, ctx) => { updateActivity(ctx); });
  pi.on("agent_start", (_event, ctx) => { updateActivity(ctx); });
  pi.on("agent_settled", (_event, ctx) => { updateActivity(ctx); });
  pi.on("ui_prompt_start", (_event, ctx) => { waiting = true; updateActivity(ctx); });
  pi.on("ui_prompt_end", (_event, ctx) => { waiting = false; updateActivity(ctx); });
  pi.on("session_shutdown", async () => {
    if (stopped) return;
    stopped = true;
    controlAbort.abort();
    await reporter?.report("idle");
  });

  pi.registerCommand("paseo", {
    description: "Paseo status and default-off control tools: /paseo [status | tools on | tools off]",
    getArgumentCompletions(prefix) {
      return ["status", "tools on", "tools off"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    async handler(args, ctx) {
      let command = args.trim();
      if (!command) {
        if (!ctx.hasUI) return;
        const selected = await ctx.ui.select(status(), ["Status", "Enable control tools", "Disable control tools"]);
        if (!selected || stopped) return;
        command = selected === "Status" ? "status" : selected === "Enable control tools" ? "tools on" : "tools off";
      }
      if (command === "status") {
        // An actual dialog, not just notify: RPC clients can show this reliably.
        if (ctx.hasUI) await ctx.ui.select(status(), ["Close"]);
        return;
      }
      if (command !== "tools on" && command !== "tools off") {
        ctx.ui.notify("Usage: /paseo [status | tools on | tools off]", "warning");
        return;
      }
      if (stopped) return;
      const enabled = command === "tools on";
      try {
        await withFileMutationQueue(settingsPath, async () => {
          const settings = readSettings(settingsPath);
          if (stopped) return;
          mkdirSync(dirname(settingsPath), { recursive: true });
          const staged = `${settingsPath}.${randomUUID()}.tmp`;
          try {
            writeFileSync(staged, JSON.stringify({ ...settings, tools: enabled }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
            renameSync(staged, settingsPath);
          } finally { rmSync(staged, { force: true }); }
          toolsEnabled = enabled;
          settingsError = undefined;
          controlAbort.abort();
          controlAbort = new AbortController();
          registerControl();
        });
        if (!stopped) ctx.ui.notify(`pi-paseo control tools ${enabled ? "on" : "off"}${enabled && !inside ? " (inactive outside Paseo)" : ""}. Other tools unchanged.`, "info");
      } catch {
        ctx.ui.notify("Could not save pi-paseo settings; control setting unchanged. Check paseo.json and directory permissions.", "error");
      }
    },
  });
}
