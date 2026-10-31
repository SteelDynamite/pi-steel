# pi-steel

A personal Pi extension collection and loadout manager, distributed as one package. Extensions remain independent modules; a loadout selects which ones Pi loads.

## Status

All 13 modules are imported. Checks cover the source package, installed npm tarball, real Pi reloads, terminal UI coexistence, subagent children, and isolated live-provider smoke tests. This is a development build, not a tagged release. Active-installation cutover remains a separate step; other environments are managed independently.

## Loadouts

Exactly one named loadout is selected:

- `full`: every bundled extension; the initial default.
- `minimal`: the manager only.
- Custom names: selected bundled IDs and external Pi package sources.

Companion skills, prompts, themes, and bundled agent definitions follow their owning extension. Inactive packages remain installed but unloaded. Previously loaded conversation text is not retroactively removed. No stacking, environment overrides, credential management, or arbitrary settings management.

| Command | Effect |
| --- | --- |
| `/steel list` | List loadouts and the selection. |
| `/steel status` | Compare the selection with configured package declarations. |
| `/steel use <name>` | Select and synchronize a loadout; reload when resources change. |
| `/steel sync` | Restore the current loadout's declarations and missing installations. |

The manager does not install, update, remove, or reconcile anything on startup. Downloads require confirmation; commands without a UI cannot approve them. Identical synchronization does not reload. Mutating commands are disabled in orchestrated children.

### Custom loadouts

Configuration is global-only at `<agent-dir>/steel.json` (normally `~/.pi/agent/steel.json`). After the first synchronization, add custom entries under `loadouts`, preserving the other fields. For a new configuration:

```json
{
  "version": 1,
  "active": "full",
  "loadouts": {
    "work": {
      "bundled": ["pi-goal", "pi-subagent", "pi-read-before-write"],
      "external": []
    }
  },
  "managed": []
}
```

Run `/steel use work`. Bundled IDs and their resources are recorded in [extensions.manifest.json](extensions.manifest.json). External entries use Pi package syntax, including pinned npm/Git sources and local package directories. Standalone file sources are rejected because Pi cannot disable them through package filters. Relative external paths resolve from the agent directory.

`managed`, the optional `pending` ownership journal, and `incomplete` download records are internal state; do not edit them. Editing configuration alone does not change loaded resources: synchronize explicitly.

### Memory preset

[presets/memory/steel.json](presets/memory/steel.json) selects all bundled extensions plus upstream [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory), pinned to upstream revision [`886f7a6`](https://github.com/elpapi42/pi-observational-memory/commit/886f7a6628d10ea420eb6ceecaee36691489b2fb). It is an external package, not a vendored module or fork. The reserved `full` and `minimal` loadouts are unchanged.

[presets/memory/settings.json](presets/memory/settings.json) supplies its configuration overrides:

| Threshold | Tokens |
| --- | ---: |
| Auto-compaction | 250,000 |
| Observation | 30,864 |
| Reflection | 61,728 |
| Observation pool maximum | 61,728 |
| Observation pool target | 30,864 |

These scale upstream's scheduling and pool defaults by `250000 / 81000`, rounded to whole tokens. `calibrated` mode keeps the compaction threshold fixed; model-dependent capacity limits and output budgets remain unchanged. The threshold counts estimated source-history tokens, not total model context. Native Pi compaction settings are not modified.

To apply during a deliberate installation or cutover:

1. For a new Steel configuration, use the preset as `<agent-dir>/steel.json`. For an existing configuration, merge only `loadouts.memory`, preserving ownership journals and other loadouts.
2. Merge the memory settings into `<agent-dir>/settings.json`'s `observational-memory` object, preserving unrelated settings and any memory model selection. Do not replace the whole settings file. These are explicit configuration overrides, not settings that Steel rewrites during synchronization.
3. Reload Pi after the settings merge, then run `/steel use memory` and approve the external package download. Do not separately install it as a manually owned package. Start a fresh session after cutover; check `/steel status` and `/om:status`.

The preset ships with Steel but is not applied on startup. Switching away unloads memory without erasing its settings or session history. Background memory workers use the session model unless configured otherwise and incur additional model usage.

### Ownership and failures

- Unrelated manual packages and resource settings are preserved.
- Selecting an already-manual external package is rejected rather than silently claiming it. Shared ownership is not supported.
- Manually removing a selected member creates drift; `/steel sync` restores it. Remove it from the loadout for permanent exclusion.
- Standalone installations of bundled extensions, direct duplicate entry paths, and project-scoped Steel declarations are rejected. Do not load the old individual installations alongside this package.
- Managed external source spelling/version cannot be changed in place. This initial manager does not provide an update or ownership-release command.
- Downloads finish before resource declarations change. Failures report completed downloads; journaled partial caches are repaired on retry rather than mistaken for successful installations.
- Settings are revalidated after confirmation and merged under Pi 1.4's settings-file lock. Atomic replacement preserves the original file if writing fails. Editors that ignore locks, concurrent project edits, and simultaneous installation of the same package are not serialized by Steel.
- An interrupted settings write retains an ownership journal for retry. A crashed process may leave `<agent-dir>/steel.lock`; remove that lock only after confirming no synchronization process remains.

Pi's own package loading/update behavior is unchanged; the no-startup-reconciliation promise applies to the Steel manager.

## Isolated local trial

Requires Node.js 22+ and Pi; integration checks currently use Pi 1.4.0. From this checkout:

```sh
npm ci --ignore-scripts
root="$PWD"
sandbox="$(mktemp -d)"
mkdir -p "$sandbox/home" "$sandbox/project"
HOME="$sandbox/home" PI_CODING_AGENT_DIR="$sandbox/agent" pi install "$root"
cd "$sandbox/project"
HOME="$sandbox/home" PI_CODING_AGENT_DIR="$sandbox/agent" pi
```

This keeps personal settings, credentials, and extension configuration separate. Model use requires a separate login in the trial environment. Install the package directory, not just `index.ts` or a parent-only `-e` flag: subagent children discover the installed package through the inherited agent directory.

Module READMEs retain predecessor usage and standalone installation references. Use the collection installation above when testing Steel; do not install those standalone sources alongside it.

## Validation

```sh
npm run check         # TypeScript, manager/host/child/TUI tests, package contents
npm run check:packed  # Install the real tarball without host peers; rerun integration tests
```

Module tests retain their separate toolchains. Bootstrap them once, then run:

```sh
for module in extensions/*; do
  (
    cd "$module"
    if test -f package-lock.json; then
      npm ci --ignore-scripts
    else
      npm install --ignore-scripts --package-lock=false
    fi
  )
done
npm run check:modules
```

Automated integration tests use temporary homes and local deterministic providers, not personal credentials or live model calls. The TUI smoke test needs a POSIX `script` PTY; additional predecessor TUI tests require `expect` and otherwise skip. Root CI installs both and runs source, module, and packed-install checks on Node.js 22, 24, and 26.

Separate, manually authorized smoke tests verified OpenAI OAuth file work and worker delegation, plus OpenRouter API-key requests. These used temporary credentials/configuration copies; they are not part of CI.

## Licenses

The manager is MIT licensed. Bundled modules retain their own license notices, including Apache-2.0 for `pi-answer` and third-party MIT attribution. `pi-mindful` is a Pi adaptation of [Halluton's Mindful-Claude](https://github.com/halluton/Mindful-Claude); its upstream MIT notice is preserved. Source revisions and import differences are recorded in the manifest.
