import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { plan, readConfig, select, synchronize, type Member } from "./src/manager.js";

const root = dirname(fileURLToPath(import.meta.url));

export default function steel(pi: ExtensionAPI): void {
  pi.registerCommand("steel", {
    description: "Loadouts: status | list | use <name> | sync (global settings; reloads on change)",
    handler: async (args, ctx) => {
      const [command = "status", name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (!["status", "list", "use", "sync"].includes(command) || extra.length || (command === "use" ? !name : name)) {
        ctx.ui.notify("Usage: /steel status | list | use <name> | sync", "error");
        return;
      }
      const agentDir = getAgentDir();
      const configPath = join(agentDir, "steel.json");
      let lock: number | undefined;
      let changed = false;
      try {
        const registry = JSON.parse(readFileSync(join(root, "extensions.manifest.json"), "utf8")) as { version: number; extensions: Member[] };
        if (registry.version !== 1 || !Array.isArray(registry.extensions)) throw new Error("Invalid bundled registry");
        const members = registry.extensions;
        const config = readConfig(configPath, members);
        if (command === "list") {
          ctx.ui.notify(["full (all bundled)", "minimal (manager only)", ...Object.keys(config.loadouts)].map(n => `${n.split(" ")[0] === config.active ? "* " : "  "}${n}`).join("\n"), "info");
          return;
        }
        // Read project declarations for collision detection only; never resolve/install project resources.
        const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: false });
        const declarations = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: true });
        const errors = [...settings.drainErrors(), ...declarations.drainErrors()];
        if (errors.length) throw new Error(errors.map(e => e.error.message).join("; "));
        // Project trust here authorizes path lookup only, never project operational settings.
        const hostSettings = SettingsManager.inMemory(settings.getGlobalSettings());
        const packages = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager: hostSettings });
        const installer = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: hostSettings });
        const host = { getInstalledPath: packages.getInstalledPath.bind(packages), install: installer.install.bind(installer) };
        if (command === "use") config.active = name!;
        const selection = select(config, members);
        const preview = plan(config, members, settings, host, root, agentDir, ctx.cwd, declarations.getProjectSettings());
        const approvedSettings = JSON.stringify(settings.getGlobalSettings());
        if (command === "status") {
          ctx.ui.notify(`Selected: ${config.active}\nBundled: ${selection.bundled.join(", ") || "none"}\nExternal: ${selection.external.join(", ") || "none"}\n${preview.changed || preview.install.length ? "Drift; run /steel sync" : "Configured declarations match (runtime requires reload after outside edits)"}`, "info");
          return;
        }
        if (process.env.PI_ORCHESTRATED_CHILD === "1") throw new Error("Steel mutation is disabled in orchestrated children");
        if (preview.install.length && (!ctx.hasUI || !(await ctx.ui.confirm("Install external packages?", preview.install.join("\n"))))) {
          ctx.ui.notify("Sync canceled; settings unchanged", "info");
          return;
        }
        mkdirSync(agentDir, { recursive: true });
        // No automatic lock stealing: another process may still be installing a package.
        lock = openSync(join(agentDir, "steel.lock"), "wx", 0o600);
        const fresh = readConfig(configPath, members);
        if (command === "use") fresh.active = name!;
        if (JSON.stringify(fresh) !== JSON.stringify(config)) throw new Error("Configuration changed during confirmation; retry");
        await settings.reload();
        await declarations.reload();
        const freshErrors = [...settings.drainErrors(), ...declarations.drainErrors()];
        if (freshErrors.length) throw new Error(freshErrors.map(e => e.error.message).join("; "));
        const refreshed = plan(config, members, settings, host, root, agentDir, ctx.cwd, declarations.getProjectSettings());
        if (JSON.stringify(refreshed) !== JSON.stringify(preview) || JSON.stringify(settings.getGlobalSettings()) !== approvedSettings) throw new Error("Settings changed during confirmation; retry");
        const result = await synchronize(config, members, settings, host, root, agentDir, ctx.cwd, configPath, declarations.getProjectSettings());
        changed = result.changed;
        ctx.ui.notify(`Selected ${config.active}; ${changed ? "resource changes saved; reloading" : "already synchronized"}`, "info");
      } catch (error) {
        ctx.ui.notify(`Steel: ${String(error)}`, "error");
      } finally {
        if (lock !== undefined) {
          closeSync(lock);
          unlinkSync(join(agentDir, "steel.lock"));
        }
      }
      if (changed) {
        await ctx.reload();
        return;
      }
    },
  });
}
