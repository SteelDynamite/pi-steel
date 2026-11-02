import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { plan, readConfig, readLoadouts, select, synchronize, type Member } from "./src/manager.js";

const root = dirname(fileURLToPath(import.meta.url));

export default function steel(pi: ExtensionAPI): void {
  // Runtime-local: saved settings can advance while this extension set stays loaded.
  // A fresh runtime after /reload or restart clears the warning, not a no-op sync.
  let reloadNeeded = false;
  let syncError: string | undefined;
  let selected: string | undefined;

  async function run(args: string, ctx: ExtensionContext, automatic = false): Promise<boolean> {
    const [command = "status", name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
    if (!["status", "list", "use", "sync"].includes(command) || extra.length || (command === "use" ? !name : name)) {
      ctx.ui.notify("Usage: /steel status | list | use <name> | sync", "error");
      return false;
    }
    const agentDir = getAgentDir();
    const configPath = join(agentDir, "steel.json");
    let lock: number | undefined;
    try {
      const registry = JSON.parse(readFileSync(join(root, "extensions.manifest.json"), "utf8")) as { version: number; extensions: Member[] };
      if (registry.version !== 1 || !Array.isArray(registry.extensions)) throw new Error("Invalid bundled registry");
      const members = registry.extensions;
      const config = readConfig(configPath, members);
      selected = config.active;
      if (command === "list") {
        const names = [...Object.keys(readLoadouts().loadouts), "full", "minimal", ...Object.keys(config.loadouts)];
        ctx.ui.notify(names.map(n => `${n === config.active ? "* " : "  "}${n}`).join("\n"), "info");
        return false;
      }
      // Validate project exclusions and collisions; never execute project npmCommand.
      const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: false });
      const declarations = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: true });
      const errors = [...settings.drainErrors(), ...declarations.drainErrors()];
      if (errors.length) throw new Error(errors.map(e => e.error.message).join("; "));
      const hostSettings = SettingsManager.inMemory(settings.getGlobalSettings());
      const packages = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager: hostSettings });
      const installer = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: hostSettings });
      const host = { getInstalledPath: packages.getInstalledPath.bind(packages), install: installer.install.bind(installer) };
      if (command === "use") config.active = name!;
      const selection = select(config, members);
      const preview = plan(config, members, settings, host, root, agentDir, ctx.cwd, declarations.getProjectSettings());
      const approvedSettings = JSON.stringify(settings.getGlobalSettings());
      if (command === "status") {
        ctx.ui.notify(`Selected: ${config.active}\nBundled: ${selection.bundled.join(", ") || "none"}\nExternal: ${selection.external.join(", ") || "none"}\nProject exclusions: ${preview.projectExcluded.join(", ") || "none"}\n${preview.changed || preview.install.length ? "Drift; run /steel sync" : "Configured declarations match"}${reloadNeeded ? "; reload or restart Pi to apply saved changes" : " (runtime requires reload after outside edits)"}${syncError ? `\nLast sync failed: ${syncError}` : ""}`, "info");
        return false;
      }
      if (process.env.PI_ORCHESTRATED_CHILD === "1") throw new Error("Steel mutation is disabled in orchestrated children");
      if (automatic && preview.install.length && ["1", "true", "yes"].includes((process.env.PI_OFFLINE ?? "").toLowerCase())) throw new Error("Automatic package installation paused in offline mode; restart online or explicitly run /steel sync");
      if (!automatic && preview.install.length && (!ctx.hasUI || !(await ctx.ui.confirm("Install external packages?", preview.install.join("\n"))))) {
        ctx.ui.notify("Sync canceled; settings unchanged", "info");
        return false;
      }
      const needsSync = preview.changed || preview.install.length || config.pending !== undefined || !!config.incomplete?.length || !existsSync(configPath) || config.active !== selected;
      if (needsSync) {
        mkdirSync(agentDir, { recursive: true });
        // No lock stealing or polling: concurrent sessions fail visibly and can retry.
        lock = openSync(join(agentDir, "steel.lock"), "wx", 0o600);
        const fresh = readConfig(configPath, members);
        if (command === "use") fresh.active = name!;
        if (JSON.stringify(fresh) !== JSON.stringify(config) || JSON.stringify(select(fresh, members)) !== JSON.stringify(selection)) throw new Error("Configuration changed during confirmation; retry");
        await settings.reload();
        await declarations.reload();
        const freshErrors = [...settings.drainErrors(), ...declarations.drainErrors()];
        if (freshErrors.length) throw new Error(freshErrors.map(e => e.error.message).join("; "));
        const refreshed = plan(config, members, settings, host, root, agentDir, ctx.cwd, declarations.getProjectSettings());
        if (JSON.stringify(refreshed) !== JSON.stringify(preview) || JSON.stringify(settings.getGlobalSettings()) !== approvedSettings) throw new Error("Settings changed during confirmation; retry");
        if (automatic && preview.install.length && ctx.mode === "tui") ctx.ui.notify(`Steel: synchronizing ${config.active}; downloading ${preview.install.length} missing package(s)`, "info");
        const result = await synchronize(config, members, settings, host, root, agentDir, ctx.cwd, configPath, declarations.getProjectSettings());
        reloadNeeded ||= result.changed;
      }
      selected = config.active;
      syncError = undefined;
      if (automatic) {
        if (ctx.mode === "tui") ctx.ui.notify(`Steel loadout: ${selected}${reloadNeeded ? ". Saved changes require /reload or a Pi restart." : ""}`, reloadNeeded ? "warning" : "info");
      } else {
        ctx.ui.notify(`Selected ${selected}; ${reloadNeeded ? "resource changes saved; reloading" : "already synchronized"}`, "info");
      }
      return reloadNeeded;
    } catch (error) {
      syncError = String(error);
      ctx.ui.notify(`Steel: ${syncError}`, "error");
      return false;
    } finally {
      if (lock !== undefined) {
        closeSync(lock);
        unlinkSync(join(agentDir, "steel.lock"));
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_ORCHESTRATED_CHILD === "1") return;
    // Lifecycle contexts cannot safely reload. Reconcile disk state only, then warn.
    await run("sync", ctx, true);
  });
  pi.on("context", event => {
    if (!reloadNeeded && !syncError) return;
    const warning = [
      `Steel selected loadout: ${selected ?? "unknown"}.`,
      ...(syncError ? [`Loadout synchronization failed: ${syncError}. Do not claim it was applied. Retry /steel sync after resolving the failure.`] : []),
      ...(reloadNeeded ? ["Saved loadout changes are not applied to this running session. Ask the user to run /reload or restart Pi before relying on the new loadout or delegating: new subagent children may load the updated configuration while this parent still uses the old one."] : []),
    ].join(" ");
    // Request-local context survives compaction while pending, without persisting a
    // stale warning in the transcript or triggering a model turn just to announce it.
    return { messages: [...event.messages, { role: "custom" as const, customType: "steel-loadout-warning", content: warning, display: false, timestamp: Date.now() }] };
  });
  pi.registerCommand("steel", {
    description: "Loadouts: status | list | use <name> | sync (global settings; reloads on change)",
    handler: async (args, ctx) => {
      if (await run(args, ctx)) await ctx.reload();
    },
  });
}
