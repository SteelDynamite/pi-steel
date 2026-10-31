import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

/** Public SDK storage contract; no dependency on the host's private storage instance. */
type SettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

/** Explicit sync only. The agent directory must already exist.
 * Compatibility: Pi 1.4.0 FileSettingsStorage uses lockSync(settingsPath,
 * { realpath: false }), hence `${settingsPath}.lock`, with proper-lockfile defaults.
 * This coordinates only with writers honoring that exact path/protocol, not editors,
 * symlink aliases, or future hosts that change it. The project file is reread under
 * the global lock but cannot be atomic with independently locked project writes.
 */
export function transactSettings<T extends { packages: PackageSource[]; changed: boolean }>(
  cwd: string, agentDir: string, update: (settings: SettingsManager) => T,
): T {
  const path = join(agentDir, "settings.json");
  // Lock before existence/read checks, including an absent settings file.
  const release = lockfile.lockSync(path, { realpath: false });
  try {
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const projectPath = join(cwd, ".pi", "settings.json");
    const project = existsSync(projectPath) ? readFileSync(projectPath, "utf8") : undefined;
    const storage: SettingsStorage = {
      withLock(scope, fn) {
        if (fn(scope === "global" ? current : project) !== undefined) {
          throw new Error("Transaction snapshot is read-only");
        }
      },
    };
    const settings = SettingsManager.fromStorage(storage, { projectTrusted: true });
    const errors = settings.drainErrors();
    if (errors.length) throw new Error(errors.map(e => e.error.message).join("; "));
    const next = update(settings);
    // Preserve unknown keys rather than serializing the host's normalized snapshot.
    if (next.changed) {
      // A failed write must not truncate unrelated settings before journal recovery.
      const temp = `${path}.${process.pid}.tmp`;
      try {
        const mode = existsSync(path) ? statSync(path).mode & 0o7777 : 0o600;
        writeFileSync(temp, `${JSON.stringify({ ...JSON.parse(current?.replace(/^\uFEFF/, "") ?? "{}"), packages: next.packages }, null, 2)}\n`, { mode });
        chmodSync(temp, mode); // Creation umask must not narrow existing access.
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
    }
    return next;
  } finally {
    release();
  }
}
