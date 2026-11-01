# Pi Subagent maintenance

Read `README.md` for product behavior, installation, and validation commands. This checkout is not a locational-agent root. Keep `agents/*/SUBAGENTS.md` as behavioral definitions. Bundled discovery and exclusion use this module's `agents/` directory; do not add a `.agents/subagents` symlink.

Keep delegation foreground-managed: each `subagent` call launches one isolated Pi child, shows progress, waits, and returns one result. Built-in `bash` owns shell commands and Pi owns concurrent sibling tool execution. Do not add detached jobs, background polling, or command execution to this extension. Preserve `exposure: "model-only"` for direct tool rendering and progress.

## Locational opt-in

Keep locational discovery, path delegation, owner prompts, and boundary guards disabled unless `PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS` is exactly `1`. Stale locational environment and `includeLocationalAgents` must not enable the feature. Behavioral children inherit the feature gate; the tool parameter only enables their advertising after opt-in. Clear inherited ownership markers when disabled. Existing session text is not retroactively removed; validate fresh sessions.

Locational tests explicitly opt in. Preserve default-off installed-copy versus separate-source-checkout regression coverage; do not hide misclassification with broad directory exclusions or project symlinks. Retained opt-in guards are not an OS sandbox; see README for limits.

## Model configuration maintenance

Pin explicit OpenAI model selectors as `openai/<model-id>`; preserve model IDs and declared thinking levels. Behavioral `whenCallerModelId` accepts a literal model ID or a nonempty YAML list of literal IDs, not provider-qualified selectors. `thenModel: caller` preserves the immediate caller's provider; an explicit `thenModel: provider/model` pins the target provider. Bundled rules match Astra and Sol 6.1: scout uses `openai/gpt-6.1-sol` low, worker the same model medium, reviewer `openai/gpt-6-astra` xhigh. Keep conditional policy in definitions, never agent-name dispatch or speed-dependent matching. See README's behavioral caller overrides for field validation and resume semantics.

When explicitly enabled, locational definitions without a model use `PI_SUBAGENT_LOCATIONAL_PREFERRED_MODELS` when available, otherwise the caller model.

Definitions are reread on each delegation and before each agent run; selector edits need no reload. Extension-code changes require `/reload`; parent environment changes require restarting Pi. The visible locational manifest is a branch snapshot, not the live selector configuration.

To bootstrap a locational agent with failed provider authentication, select an authenticated caller model first. An unavailable explicit selector uses the caller immediately; a selected non-caller model may retry once with the caller after a qualifying pre-work provider failure. Preferred-model environment settings do not override explicit `model:` entries.

## Launcher identity

Use the hosting Pi's exported `getPackageDir()` through Pi's extension module mapping, then its `package.json` identity and `bin.pi`; do not infer a CLI from host `process.argv[1]` or an arbitrary executable. SDK entrypoints can be credential-bearing bots. Do not replace this with bare `pi`/PATH lookup or forward host runtime flags. `PI_PACKAGE_DIR`, when set, must describe the intended complete Pi distribution, not an assets-only directory.

Node.js/Bun script launches require the declared CLI file. Pi's compiled Bun layout ships `pi` (`pi.exe` on Windows) beside package metadata; only that matching executable is reusable. Source-only or stripped SDK distributions without a CLI fail closed before session allocation, prompt creation, spawn, or model fallback. The host-provided peer is optional for package installation and standalone tests, but required at delegation time; do not bundle a second SDK to resolve it.

Launcher tests must supply package identity separately from inert host entrypoints. Keep cwd, environment, foreground cleanup, resume and model-fallback semantics unchanged. A successful version/startup smoke is not live provider or remote bot-incident validation.

## Token-speed maintenance

`token-speed.ts` is a self-contained adaptation of `pi-token-speed` 0.1.0 `src/token-speed.ts` (MIT), not a runtime dependency. Golden parity fixtures in `test/fixtures/token-speed.mjs` record the reference source SHA-256. Preserve footer measurement semantics, including first-chunk omission live versus first-token subtraction at completion; do not substitute runtime-average throughput. Reference updates require explicit parity checks, not automatic sibling imports.

Keep measurement state per launch attempt, use monotonic receipt time injected through `runDelegation`, and preserve optional numeric `SingleResult.tokenSpeed` through nested caps and final tool details. Decode stdout incrementally as UTF-8 and timestamp each received chunk once before parsing; records received together must not acquire artificial timing from parsing or progress callbacks. Count only assistant text/thinking/toolcall deltas, never cumulative snapshots or nested results. Finalize from completed calls on process close; do not save an unfinished live estimate as final. Never reconstruct historical timing from the wall clock. Speed-driven publication is event-throttled (250 ms), with no timer; existing message/nested updates stay immediate.
