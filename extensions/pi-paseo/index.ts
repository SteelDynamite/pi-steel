import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityConnection, ActivityReporter } from "./activity.js";
import { controlSchema, executeControl } from "./control.js";
import { createDiagnostics, diagnosticIdentity, type ActivityDiagnostics, type DiagnosticFields } from "./diagnostics.js";

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
  let diagnostics: ActivityDiagnostics | undefined;
  let eligibility: DiagnosticFields["eligibility"];
  let diagnosticsUnavailable = false;
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

  function updateActivity(ctx: ExtensionContext, source: DiagnosticFields["source"], aborted?: boolean) {
    if (stopped) return;
    const idle = ctx.isIdle();
    const state = waiting ? "needs-input" : idle ? "idle" : "running";
    const facts = { source, idle, waiting, aborted };
    diagnostics?.emit({ phase: "lifecycle", state, ...facts });
    void reporter?.report(state, facts);
  }

  function status() {
    return [
      `Paseo: ${inside ? "detected" : "not detected"}.`,
      `Terminal activity: ${reporter ? reporter.error ?? "enabled (best effort)" : "inactive (requires a Paseo TUI and valid loopback endpoint)"}.`,
      `pi-paseo control tools: ${toolsEnabled ? inside ? "on" : "on in settings, inactive outside Paseo" : "off"}.`,
      "Paseo-injected tools are managed separately and are unchanged.",
      `Settings: ${settingsPath}`,
      diagnostics?.status() ?? (diagnosticsUnavailable ? "Diagnostics: disabled (initialization failed)." : `Diagnostics: inactive (${eligibility ?? "not started"}); no file opened.`),
      ...(settingsError ? [settingsError] : []),
    ].join("\n");
  }

  pi.on("session_start", async (event, ctx) => {
    try { toolsEnabled = readSettings(settingsPath).tools === true; }
    catch (error) {
      settingsError = (error as Error).message;
      toolsEnabled = false;
      ctx.ui.notify(settingsError, "warning");
    }
    registerControl();
    const connection = ctx.mode === "tui" ? activityConnection(env) : undefined;
    eligibility = ctx.mode !== "tui" ? "non_tui" : !env.PASEO_TERMINAL_ID ? "outside_paseo" : !connection ? "invalid_connection" : "enabled";
    // No disk work in children, native/RPC sessions, or outside Paseo. Invalid
    // injected TUI connections still leave a safe startup diagnostic.
    if (ctx.mode === "tui" && inside) {
      try {
        diagnostics = createDiagnostics(env.PASEO_TERMINAL_ID);
        diagnostics.emit({ phase: "lifecycle", source: "session_start", reason: event.reason, eligibility, idle: ctx.isIdle(), waiting });
      } catch { diagnosticsUnavailable = true; }
    }
    if (connection) {
      reporter = new ActivityReporter(connection, diagnostics);
      // Finish startup reset before work can begin, so even a fast first turn
      // produces running -> idle rather than being coalesced into startup idle.
      await reporter.report("idle", { source: "session_start", reason: event.reason, idle: ctx.isIdle(), waiting });
    }
  });
  pi.on("before_agent_start", (_event, ctx) => { updateActivity(ctx, "before_agent_start"); });
  pi.on("agent_start", (_event, ctx) => { updateActivity(ctx, "agent_start"); });
  // Observation only: agent_end is not a final-idle reporting boundary.
  pi.on("agent_end", (_event, ctx) => {
    if (!stopped) diagnostics?.emit({ phase: "lifecycle", source: "agent_end", idle: ctx.isIdle(), waiting });
  });
  pi.on("agent_settled", (event, ctx) => { updateActivity(ctx, "agent_settled", event.aborted); });
  pi.on("ui_prompt_start", (_event, ctx) => { waiting = true; updateActivity(ctx, "ui_prompt_start"); });
  pi.on("ui_prompt_end", (_event, ctx) => { waiting = false; updateActivity(ctx, "ui_prompt_end"); });
  pi.on("tool_execution_start", (event, ctx) => {
    if (!stopped && diagnostics && event.toolName === "subagent") diagnostics.emit({
      phase: "subagent_start", call: diagnosticIdentity(event.toolCallId), idle: ctx.isIdle(), waiting,
    });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (!stopped && diagnostics && event.toolName === "subagent") diagnostics.emit({
      phase: "subagent_end", call: diagnosticIdentity(event.toolCallId), idle: ctx.isIdle(), waiting, isError: event.isError,
    });
  });
  pi.on("session_shutdown", async (event, ctx) => {
    if (stopped) return;
    stopped = true;
    controlAbort.abort();
    const facts = { source: "session_shutdown" as const, reason: event.reason, idle: ctx.isIdle(), waiting };
    diagnostics?.emit({ phase: "lifecycle", state: "idle", ...facts });
    await reporter?.report("idle", facts);
    // Do not flush/wait for disk. The process-owned bounded writer may finish
    // already queued records; runtime closures are never retained by it.
    diagnostics?.close();
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
