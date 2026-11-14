# pi-steel

A personal Pi extension collection and loadout manager, distributed as one package. Extensions remain independent modules; a loadout selects which ones Pi loads.

## Status

Bundled modules are listed in [extensions.manifest.json](extensions.manifest.json). Automated checks cover source and installed-tarball loading, Pi reloads, terminal UI coexistence, and subagent children using isolated local providers. Coverage is not certification of every renderer or terminal. Earlier live-provider and local-cutover checks do not validate this build. This is a development build, not a tagged release; other environments require their own installation and validation.

## Loadouts

Exactly one named loadout is selected:

- `Everything` (default): all bundled extensions plus external upstream observational memory.
- `ChatBot`: system reminders, subagent, and external upstream observational memory.
- Legacy `full` (all bundled extensions), `minimal` (manager only), and custom loadouts remain supported.

Shipped selections come from [loadouts.json](loadouts.json), read dynamically rather than copied into local configuration. Pull or update Steel to receive definition changes; there is no background polling or package update.

Companion skills, prompts, themes, and bundled agent definitions follow their owning extension. Inactive packages remain installed but unloaded. Previously loaded conversation text is not retroactively removed. No stacking, environment overrides, credential management, or arbitrary settings management.

| Command | Effect |
| --- | --- |
| `/steel list` | List loadouts and the selection. |
| `/steel status` | Compare the selection with configured declarations; report pending reloads or sync failures. |
| `/steel use <name>` | Select and synchronize a loadout; reload when resources change. |
| `/steel sync` | Restore the current loadout's declarations and missing installations. |

Steel synchronizes on each `session_start`, including reloads. Missing packages install without confirmation unless `PI_OFFLINE` is `1`, `true`, or `yes` (case-insensitive), which blocks automatic installation. Already installed packages are not updated. Orchestrated children (`PI_ORCHESTRATED_CHILD=1`) skip mutations.

Automatic synchronization changes disk configuration, not the current extension set. TUI startup notifications and `/steel status` show the selected name and any pending reload. Steel does not publish a persistent footer status, leaving that space for token speed and other extension statuses. Until a new runtime starts, request-local model context warns that `/reload` or a Pi restart is needed and that new children may differ from their old parent. This warning neither starts a model turn nor persists in conversation history.

Explicit `/steel use` and `/steel sync` still require confirmation for missing downloads; commands without a UI cannot approve them. They reload when changes are pending, including changes already saved by automatic synchronization. A true no-op does not reload. Failures appear in the TUI and model context, never as successful synchronization.

### Custom loadouts

Configuration is global-only at `<agent-dir>/steel.json` (normally `~/.pi/agent/steel.json`). After the first synchronization, add custom entries under `loadouts`, preserving the other fields. For a new configuration:

```json
{
  "version": 1,
  "active": "Everything",
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

`managed`, the optional `pending` ownership journal, and `incomplete` download records are internal state; do not edit them. Do not copy shipped definitions into `loadouts`. Editing configuration alone does not change loaded resources: run `/steel sync`, or let the next session start synchronize and then reload if prompted.

### Project-local exclusions

Keep the global loadout and disable bundled extensions in one trusted project using Pi's `autoload: false` package delta. For a global HTTPS Git installation, merge this entry into `.pi/settings.json`'s `packages` array, preserving other settings and packages:

```json
{
  "packages": [
    {
      "source": "https://github.com/SteelDynamite/pi-steel.git",
      "autoload": false,
      "extensions": ["-extensions/pi-doc-manifests/index.ts"],
      "skills": ["!extensions/pi-doc-manifests/skills/**/*"]
    }
  ]
}
```

Use the same package identity as your global declaration, retaining its source/ref. For local installations, use the same absolute package path or a path relative to the project's `.pi` directory—not the agent directory. Do not install a second copy of Steel.

Only one Steel delta is allowed. Use exact `-<entry>` exclusions from [extensions.manifest.json](extensions.manifest.json), plus `!<directory>/**/*` for **every** declared skill, prompt, or theme directory owned by each excluded extension. Omit resource types with no companions. Empty arrays mean no change in a delta, not “disable all.” Inclusions, arbitrary globs, manager exclusion, and independent companion toggles are rejected. Asset files need no filters; they are used only by their owning extension.

Run `/reload` or restart Pi after editing project settings. `/steel status` lists configured project exclusions; `/steel sync` preserves them without changing the global selection. Other projects remain unaffected. Children use the exclusions when running in the same working directory with project trust granted; a one-run parent `--approve` does not grant trust to children. Remove the delta and reload to restore the global selection.

An unrelated replacement can be added separately through Pi's normal resource settings. Existing bundled-name/source and duplicate-path collision checks still apply; this is exclusion support, not permission to load standalone copies of bundled modules. Disabling doc manifests does not delete project-owned creator skills or prior conversation text.

### Paseo

`Everything` includes [pi-paseo](extensions/pi-paseo/README.md): automatic terminal activity and waiting-for-input reporting inside Paseo, without duplicating its native Pi chat integration. Outside Paseo and in orchestrated children, reporting is inactive.

Paseo control tools default **off**. Use `/paseo` or `/paseo tools on|off`; the global setting lives in `<agent-dir>/paseo.json`. This controls only `pi-paseo`'s own tool, leaving Paseo-injected tools untouched. Controls use the existing Paseo CLI and require one unambiguous inherited `PASEO_HOME` or `PASEO_HOST`; the extension does not read credentials or edit Paseo settings. See the module README for commands, notification limits, and validation boundaries.

### Herdr (`hc`)

Keep `Everything`, `ChatBot`, or a custom loadout containing `pi-subagent`. Inside [Herdr](https://herdr.dev/core/), `pi-subagent` detects `HC_TERMINAL_ID` and checks `hc --skill`. If available, it preloads the installed manual, bundled delegation guidance, and current session launch values into the model's context instead of registering the native `subagent` tool, settings command, and behavioral-agent advertising. No initial skill read, repeated `hc --skill`, or environment lookup is needed. No separate Herdr extension, skill package, or loadout is required.

Outside Herdr, or if the check fails, native delegation remains available. A failed check shows one warning per parent runtime with installation/PATH and reload instructions. Explicitly enabled locational guards keep native delegation even inside Herdr. Detection is process-local: simultaneous Herdr and ordinary Pi sessions share the same loadout without changing each other's settings. `/reload` rechecks availability; no polling or automatic installation occurs.

Herdr handoff does not translate behavioral definitions, preserve native subagent lifecycle guarantees, or automatically copy the parent's model, effort, or speed. Herdr templates or the launched agent's defaults determine those settings. The guidance requires Pi helpers to receive `PI_ORCHESTRATED_CHILD=1` and the intended `PI_CODING_AGENT_DIR` explicitly, preserving supervisor suppression and resource selection without assuming the daemon inherits the calling shell's environment. See [pi-subagent's Herdr behavior](extensions/pi-subagent/README.md#herdr-handoff) for limits.

### Optional keybindings

[presets/keybindings.json](presets/keybindings.json) maps Alt+↑/↓ to one-line transcript scrolling in **fullscreen mode**, and moves restoring queued messages to Alt+Q. Regular mode uses the terminal's scrollback instead. Focused overlays and lists retain their own keyboard handling.

To apply, back up `<agent-dir>/keybindings.json` (normally `~/.pi/agent/keybindings.json`), then merge the preset's three entries into it, preserving unrelated bindings. Create the file if absent. Check other custom actions for conflicting keys, then run `/reload`. To undo, restore the previous values or remove these entries if they were previously absent, then reload.

This is an opt-in configuration fragment, not an automatically loaded Pi package resource. Installing/updating Steel or switching loadouts does not apply, update, or remove it. It does not change the display mode.

### Observational memory

All shipped loadouts include upstream [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory), tracking its unpinned Git default branch. It remains an external package, not a vendored module or fork. [presets/memory/steel.json](presets/memory/steel.json) is a legacy compatibility snapshot, not the recommended shipped selection; use `Everything` or `ChatBot` instead.

Steel manages exactly three keys in `<agent-dir>/settings.json`'s `observational-memory` object, using the shipped [presets/memory/settings.json](presets/memory/settings.json):

| Managed key | Tokens |
| --- | ---: |
| `compactAfterTokens` | 204,000 |
| `observeAfterTokens` | 25,185 |
| `reflectAfterTokens` | 50,370 |

These scale upstream's scheduling defaults by `204000 / 81000`, rounded to whole tokens. Compaction is fixed at 204K: nominally 75% of a 272K window, **not** automatically 75% of every model. OM counts estimated observed source-history tokens, not total model context. Its default `calibrated` mode uses the fixed threshold; Pi's native context-pressure compaction remains independent.

When the selected loadout includes upstream Git memory, session-start synchronization and `/steel use` or `/steel sync` replace local values for those three keys. Updated Steel packages supply the current values dynamically; they are not copied into `steel.json`. This includes custom loadouts selecting the same upstream Git identity, but not arbitrary local or npm memory packages. Existing package ownership checks still apply: Steel will not silently claim a manually installed memory package.

All other settings remain user-owned, including memory models, pool budgets, passive mode, capacity/output limits, and native Pi compaction. Existing pool budgets are preserved; new installations retain upstream's pool defaults. Steel does not write project settings. A conflicting project threshold, a malformed memory namespace, or `compactAfterTokensMode: "ratio"` stops synchronization with an error rather than silently shadowing the managed policy or changing an unowned key. Remove conflicting overrides or explicitly choose `calibrated` mode before retrying. Matching project thresholds are accepted but may conflict with a later policy update.

To apply:

1. Select `/steel use Everything` or `/steel use ChatBot`; approve any missing external package download. Do not separately install memory as a manually owned package.
2. Explicit commands reload after saved changes. Automatic startup synchronization changes disk only; follow its `/reload` or restart warning before relying on the updated runtime. Children may otherwise read newer settings than the parent.
3. Check `/steel status` for managed targets/drift and `/om:status` for the running memory thresholds. Start a fresh session after a cutover.

Disabling memory in the selected loadout stops threshold management without erasing saved settings. To use different thresholds, first select a loadout without managed upstream memory; otherwise synchronization restores the shipped values. The legacy configuration snapshot is not applied automatically. Initial installation resolves upstream's current default branch; later upstream changes require an explicit `pi update git:https://github.com/elpapi42/pi-observational-memory.git` and reload. `/steel sync` restores missing members; it does not update an already installed member. Steel's development lockfile records the tested Git artifact, not a runtime pin: it does not constrain what Pi downloads. The validated artifact is [`0fc37e6`](https://github.com/elpapi42/pi-observational-memory/commit/0fc37e67d977d1d76eab121786a319f5f07ec7d3); its declared `dist/index.ts` reproduces byte-for-byte from upstream's build and includes the unobserved-context safeguards. Future upstream revisions require revalidation. Switching away unloads memory without erasing its settings or session history. Background memory workers use the session model unless configured otherwise and incur additional model usage.

### Ownership and failures

- Unrelated manual packages and resource settings are preserved.
- Selecting an already-manual external package is rejected rather than silently claiming it. Shared ownership is not supported.
- Manually removing a selected member globally creates drift; automatic synchronization or `/steel sync` restores it. Change the loadout for global exclusion or use a project-local exclusion above.
- Standalone installations of bundled extensions and direct duplicate entry paths are rejected. Project Steel declarations are limited to the exclusion delta above. Do not load the old individual installations alongside this package.
- Managed external source spelling/version cannot be changed in place. This initial manager does not provide an update or ownership-release command.
- Downloads finish before resource declarations change. Failures report completed downloads; journaled partial caches are repaired on retry rather than mistaken for successful installations.
- Settings are revalidated after confirmation and merged under Pi 1.4's settings-file lock. Atomic replacement preserves the original file if writing fails. Editors that ignore locks, concurrent project edits, and simultaneous installation of the same package are not serialized by Steel.
- An interrupted settings write retains an ownership journal for a later synchronization. Lock contention fails visibly: Steel neither steals locks nor runs retry loops. A crashed process may leave `<agent-dir>/steel.lock`; remove that lock only after confirming no synchronization process remains.

Pi's own package loading/update behavior is unchanged.

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

Install root dependencies with `npm ci --ignore-scripts`. Module tests retain their separate toolchains; bootstrap them once:

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
```

Then run the complete validation sequentially:

```sh
npm run check:all     # check → check:modules → check:packed; stops on failure
```

Individual suites remain available:

- `npm run check`: TypeScript, manager/host/child/TUI tests, package contents.
- `npm run check:modules`: each module's checks, one module at a time.
- `npm run check:packed`: install the real tarball without host peers and rerun integration tests.

Never overlap heavyweight suites, even across agent sessions or checkouts on the same shared host. Node test runners use `--test-concurrency=1`; tests needing concurrent Pi runtimes bound their own fan-out. This reduces memory pressure but is not a RAM ceiling. `check:all` sequences one invocation; it does not lock out other invocations.

Automated integration tests use temporary homes and local deterministic providers, not personal credentials or live model calls. The TUI smoke test needs a POSIX `script` PTY; additional predecessor TUI tests require `expect` and otherwise skip. Root CI installs both and runs source, module, and packed-install checks on Node.js 22, 24, and 26.

Separate, manually authorized smoke tests verified OpenAI OAuth file work and worker delegation, plus OpenRouter API-key requests. These used temporary credentials/configuration copies; they are not part of CI.

## Licenses

The manager is MIT licensed. Bundled modules retain their own license notices, including Apache-2.0 for `pi-answer` and third-party MIT attribution. `pi-mindful` is a Pi adaptation of [Halluton's Mindful-Claude](https://github.com/halluton/Mindful-Claude); its upstream MIT notice is preserved. Source revisions and import differences are recorded in the manifest.
