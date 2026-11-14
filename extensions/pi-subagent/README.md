# Pi Subagent

Foreground-managed behavioral Pi-agent delegation, with optional locational agents and automatic Herdr handoff. In native mode, each `subagent` call runs one isolated Pi child and returns its result; built-in `bash` owns shell execution. This extension exports no slash-command prompt templates.

## Features

- Behavioral discovery precedence: bundled, user, then trusted-project definitions.
- One-off model/thinking/tool overrides for existing roles, or inline agents with custom instructions.
- Default-off locational `SUBAGENTS.md` discovery, source-root boundaries, and recursion guards.
- One-agent progress, abort propagation, context-limit reporting, resumable sessions, and one same-session locational-model fallback.
- A trusted-parent TUI locational-agent manifest matching the parent prompt.
- Behavioral children do not advertise locational agents unless requested.

## Installation

This checkout stays at its existing path. Install the extension under its package name:

```bash
mkdir -p ~/.pi/agent/extensions/pi-subagent
ln -sf "$(pwd)/index.ts" ~/.pi/agent/extensions/pi-subagent/index.ts

mkdir -p ~/.pi/agent/agents
for d in agents/*; do ln -sfn "$(pwd)/$d" ~/.pi/agent/agents/$(basename "$d"); done
```

### Runtime requirements

Delegation requires the hosting `@earendil-works/pi-coding-agent` package to include its runnable CLI, not just an embedded SDK. Node.js and Bun script hosts use that package's declared `bin.pi`; packaged Bun Pi executables use the adjacent Pi distribution. SDK host entrypoints (including bots) are never reused as worker scripts. Missing or unidentifiable CLI installations fail before spawning; there is no `PATH` fallback. Source-only SDK builds need a built CLI. Child environment inheritance is unchanged, not credential isolation.

## Herdr handoff

With a nonempty `HC_TERMINAL_ID`, initialization runs `hc --skill` once through Pi's subprocess API (3-second timeout, 256 KiB output cap). A successful, untruncated manual identifying `herdr-core` is cached for that extension runtime. Before each model run, one named system-prompt section supplies that manual, the bundled delegation guidance, and JSON-encoded `HC_TERMINAL_ID`, resolved `PI_CODING_AGENT_DIR`, cwd, and project trust. Only those launch values are included, not the general process environment. The manual is not vendored or written to disk.

The guide is preloaded, not advertised as a skill to read. The model need not reread it, rerun `hc --skill`, or look up the supplied environment. Independent remaining template/help lookups should be batched and reused. This trades upfront context tokens in Herdr sessions for fewer preparatory model turns; actual agent behavior can still require discovery. The check reads the binary's manual, not daemon health or account readiness, and does not start a core.

In handoff mode, the module is imported but registers no native tool, settings command, behavioral advertising, or native lifecycle handlers. It does not translate `SUBAGENTS.md`, launch agents itself, or enforce native resume, model-selection, boundary, or cleanup policies. The model operates `hc` through its shell tool. Templates or the launched agent's defaults choose model, thinking, and speed; the parent's temporary selections are not automatically inherited.

Outside `hc` (including the older `HERDR_ENV`-based TUI), normal delegation is unchanged. Missing/broken `hc`, a failed or truncated check, or a missing loader retains normal delegation and produces one TUI/RPC warning per parent runtime. Orchestrated children stay quiet. Explicit `PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS=1` always retains native delegation and its guards instead of handing off. `/reload` rechecks the decision; there are no retries, background probes, automatic installs, or global setting changes.

Install/update `hc` separately from <https://herdr.dev/core/> and ensure it is on Pi's `PATH`. If the guide is missing, reinstall the package containing this extension. `skills/herdr-delegation/SKILL.md` remains an internal, owner-controlled guidance asset; it is neither advertised nor exposed as a skill command. Excluding this extension also removes its prompt section on reload. A separate official Herdr skill installation is unnecessary.

The guidance directs Pi helper launches to explicitly set `PI_ORCHESTRATED_CHILD=1` and the intended `PI_CODING_AGENT_DIR`, and to choose cwd and project trust deliberately. This is agent guidance, not a launcher guarantee. Do not assume the daemon inherits the caller's environment or that helpers inherit parent `-e` flags. Model-driven `hc` delegation and non-Linux behavior require separate runtime validation; successful manual discovery alone does not establish them.

Native prompt guidance uses the `pi_subagent` system-prompt section; Herdr handoff uses `herdr_delegation`. Each hook replaces only its own section, preserving other extensions' sections and per-request prompt updates. Empty native guidance removes its section. These hooks require Pi's structured `systemPromptOptions.sections` API; Steel's integration tests target Pi 1.4.0.

## Tool

In native mode, a file-backed `subagent` call looks like:

```json
{
  "id": "scout",
  "session": "new",
  "task": "Find authentication code",
  "contextDocs": ["/absolute/product-guidance.md"],
  "includeLocationalAgents": false
}
```

`id`, `session`, and `task` are required. `contextDocs`, `includeLocationalAgents`, `overrides`, and `custom` are optional; `overrides` and `custom` are mutually exclusive. Use `resume` only when the prior result requests it. Behavioral agents inherit the caller directory. With locational support enabled, locational-agent ids are absolute or caller-relative folders containing `SUBAGENTS.md` and run from that source root. `includeLocationalAgents` controls behavioral-child advertising only; it cannot enable locational support.

Use ordinary `bash` calls for shell commands and sibling/later `subagent` calls for concurrent/sequential delegation. Different agents may run concurrently. A resumable agent allows one active call per parent/agent and per saved child session ID in this extension runtime; overlapping calls fail immediately rather than queue. Reservations cover launcher/prompt preparation, process close, fallback, and state persistence. They are not cross-process filesystem locks.

Failed or aborted resumable calls discard their saved reuse record and request `session: "new"`; successful calls retain threshold-based reuse. Process errors remain owned until Node reports `close`, including failed spawns. Cancellation remains the primary outcome when termination also reports an error. No execution deadline or process-tree supervisor is provided.

Final answers join all nonempty text blocks of the last text-bearing assistant message in order; thinking is excluded and tool-only tails do not erase the answer. Native tool-result usage includes child assistant calls, descendant tool-result usage, and failed fallback attempts, so host session totals include delegated work. Displayed per-attempt usage and token speed remain separate. Nested progress retains at most 16 calls, each serialized call bounded to 20 KiB; oversized details/errors are visibly truncated. This does not cap the child's overall stdout, transcript, or execution.

## One-off configurations

Use `overrides` to keep an existing behavioral role's instructions while changing its model, thinking level, or tools for one call:

```json
{
  "id": "reviewer",
  "session": "new",
  "task": "Audit pi-doc-manifests without changing files.",
  "overrides": {
    "model": "openrouter/anthropic/claude-fable-5.2",
    "thinking": "high",
    "tools": ["read", "grep", "find", "ls"]
  }
}
```

Use `custom` to supply a new role without creating a definition file:

```json
{
  "id": "intent-auditor",
  "session": "new",
  "task": "Identify intended behavior, contradictions, and open questions.",
  "custom": {
    "instructions": "Perform a read-only audit. Cite evidence and separate explicit intent from inference.",
    "model": "openrouter/anthropic/claude-fable-5.2",
    "thinking": "high",
    "tools": ["read", "grep", "find", "ls"]
  }
}
```

- Both forms require `session: "new"`. They neither reuse nor replace an existing role's resumable session and do not create a reusable definition or saved one-off configuration. The parent transcript still records the call and result.
- `overrides` requires at least one of `model`, `thinking`, or `tools`. The selected definition and its caller-model rule resolve first; supplied fields win afterward. Omitted fields retain the effective role defaults, including ordinary model-fallback warnings when no per-call model is supplied. Role instructions cannot be replaced through `overrides`.
- `custom.instructions` is required and nonblank. It is literal appended system text, not a replacement for Pi's base instructions; `@file` includes are not expanded. Its `id` must be an unused lowercase kebab-case label. A colliding role requires `overrides`, not `custom`.
- A supplied `model` is one exact, case-sensitive `provider/model` from the parent's available registry, including model IDs containing slashes as above. Bare IDs, candidate lists, fuzzy patterns, and unavailable/unauthenticated selections fail before launch. No caller-model retry follows a one-off provider failure. Add newly released models through Pi's model configuration/catalog, not through the tool.
- Pi's CLI can fuzzy-match models when child resources differ. A temporary child extension checks the resolved identity at input time and rejects substitutions before the initial model request. This pins startup identity, not later deliberate model changes or a provider's internal routing. It does not forward arbitrary parent `-e` flags or make parent-only providers available in the child.
- Omitted custom `model` uses the caller model; omitted custom `thinking` and `tools` use Pi child defaults. Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; Pi clamps to model support.
- `tools` contains unique, exact known names; `[]` sends `--no-tools`. A nonempty list uses Pi's `--tools` selection. This is not an OS sandbox or a promise that all named parent-only tools exist in the child. Normal package discovery and Pi's MCP/tool-exposure rules still apply; a selected `bash` can write files.
- One-offs are behavioral-only, run in the caller directory, and retain ordinary trust, recursion, cancellation, progress, and orchestrated-child protections. `includeLocationalAgents` retains its existing default-off gate; one-offs cannot supply locational roots or lifecycle overrides. Native configuration is unavailable during Herdr handoff.
- Instructions and the startup identity check use protected temporary files cleaned up through the existing foreground lifecycle. Cards and model-facing results label the one-off mode, selected model, declared thinking, and tool selection. `details.results[]` adds `configuration` (`overrides` or `custom`) and `agentTools`; existing model/thinking fields remain authoritative for launch settings. Unspecified thinking is reported as the Pi default, not inferred.

Use file-backed definitions for reusable behavior. One-off configuration does not change saved definitions, credentials, or loadouts.

## Token speed

Compact, expanded, and nested cards show live **~25.0 tok/s** estimates and a stable **25.0 tok/s** aggregate after each model call. No footer entries are added.

Measurement matches `pi-token-speed` 0.1.0:

- Live: five-second rolling window, 500 ms warm-up, four characters per token for text, thinking, and tool-call argument deltas. The entire first emitted chunk is omitted.
- Completed calls: reported `usage.output` minus one token when positive and finite; otherwise characters after the first chunk divided by four.
- Timing: first-to-last emitted delta, excluding TTFT, tool execution, and completion-tail latency. Final speed is total measured tokens divided by total measured duration, not an average of call rates.

Rates describe observed generation throughput, not end-to-end task speed or a service-tier guarantee. Hidden reasoning can skew comparisons, and child stdout buffering affects observed timing. The final number can also use the character fallback. All records received in one stdout chunk share a timestamp; parsing and rendering those records do not create artificial generation time. A response received entirely in one chunk has no measurable duration and contributes no rate. Calls without two time-separated nonempty deltas or positive measured tokens contribute nothing. Tool waits retain the last aggregate; the next call starts a fresh live warm-up.

Each new, resumed, or fallback launch starts fresh. Descendants retain their own rates, never added to the parent's rate. Interrupted streams without a completed assistant message contribute no final measurement; any earlier completed calls in that launch retain their aggregate. Older results and missing/malformed measurements show no label. Historical cards use stored numbers, never the current clock.

Structured `details.results[].tokenSpeed` contains `{ mode: "live" | "aggregate", tokens, durationMs }`; `tokens` is the already-adjusted numerator (possibly fractional), and `durationMs` its measured denominator. Speed-only progress updates are event-driven, at most once per 250 ms; completion and nested progress remain immediate. No timer or dependency on another extension is needed. Requested service speed below is independent of this measurement.

## Requested speed indicator

Subagent status may show **Ultrafast requested**. The optional `requestedSpeed: "ultrafast"` result field records launch-time intent and drives compact, expanded, historical, and nested displays. It is captured separately for each launch, including resume and model-fallback retries; later parent setting changes do not relabel an existing result.

The label requires the final child environment's `PI_CHATGPT_SPEED`, lowercased without trimming, to equal `ultrafast`, plus child model ID `gpt-6-astra` or `gpt-6.1-sol`, provider `openai`, and OAuth according to Pi's model registry. Eligibility is checked for the child, not the parent. `PI_CHATGPT_FAST` describes the parent's effective acceleration and is not used to infer this label; `FAST=0` does not prevent an eligible child from requesting Ultrafast.

This snapshot assumes the child loads `pi-chatgpt` with the same effective authentication configuration. It is **not** proof of a request payload, server acceptance, or delivered service tier, and does not track later changes inside the child. No label means unknown—not confirmed Standard. Fast, persistent speed-config fallback, unavailable model/auth information, and older results without the field remain unlabeled. Environment inheritance itself is unchanged.

## Agent definitions

Behavioral agent directories and locational roots both use `SUBAGENTS.md`. Definitions may set a fixed Pi thinking default:

```yaml
---
description: Investigates code.
thinking: high
---
```

`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. When declared, every new and resumed child receives `--thinking <level>`, overriding that child's startup and saved-session setting. Omit it to preserve Pi's existing child defaults. A new-session behavioral one-off can override it through `overrides.thinking`; ordinary and resumed calls retain definition policy. Pi still clamps levels to selected-model support.

The bundled `worker-visual` is recommended for any task requiring image inspection, including screenshots, diagrams, and mixed image/text work. It has full worker capabilities and defaults to `openai/gpt-6-astra` with `medium` thinking for every caller, without a conditional caller rule. Pass accessible image paths or URLs in the task; it should inspect actual images and report visual uncertainty rather than infer their contents from text alone. Ordinary model-availability fallback still applies; the role does not enforce vision capability on a fallback model.

### Behavioral caller overrides

A behavioral definition may declare one flat conditional rule alongside its existing defaults:

```yaml
model: openai/gpt-6-luna
whenCallerModelId: [gpt-6-astra, gpt-6.1-sol]
thenModel: openai/gpt-6.1-sol
thenThinking: low
```

All three conditional fields are required together; locational definitions reject them.

- `whenCallerModelId`: one exact, case-sensitive **model ID** or a nonempty YAML list of IDs (inline or block). Any listed ID matches; provider and speed are irrelevant. It checks the immediate delegating session, including nested delegation, not the original ancestor. IDs cannot contain whitespace, commas, brackets, or wildcards. This is not a `provider/model` selector; slashes are literal parts of an ID. Existing scalar conditions remain supported.
- `thenModel`: `caller` or one explicit `provider/model` selector, without whitespace, commas, brackets, or wildcards. `caller` uses the immediate caller's exact provider/model directly, without a registry lookup. An explicit target selects that exact provider/model from Pi's available registry; it never substitutes another provider. If unavailable, it warns and uses the caller model with `thenThinking`, not the ordinary definition's defaults.
- `thenThinking`: one supported thinking level, overriding the ordinary `thinking` field on a match.

Nonmatching or unavailable caller identity leaves ordinary `model` and `thinking` behavior unchanged. The winning bundled/user/project definition owns the complete rule; fields are not merged across definitions. Invalid rules report configuration errors and are not loaded.

Bundled definitions match **both `gpt-6-astra` and `gpt-6.1-sol`, at every caller speed**:

| Agent | Target | Thinking |
|---|---|---|
| Scout | `openai/gpt-6.1-sol` | `low` |
| Worker | `openai/gpt-6.1-sol` | `medium` |
| Reviewer | `openai/gpt-6-astra` | `xhigh` |

These explicit targets use `openai` even when the matching caller uses another provider. For these three roles, unrelated callers retain the existing models (scout `openai/gpt-6-luna`, worker `openai/gpt-6.1-sol`, reviewer `openai/gpt-6-astra`) and omitted thinking. Speed and thinking are independent; inherited environment, including `PI_CHATGPT_SPEED`, passes through unchanged. Ultrafast service still depends on the child's provider, authentication, and `pi-chatgpt` support.

Rules are reevaluated for every delegation, including resume. Effective model and declared thinking are passed to the child and reported in results; Pi may clamp thinking to model support. If a custom resumable agent switches to an unmatched rule with omitted thinking, no thinking flag is sent: Pi's saved effort may persist. No restoration mechanism is added. Bundled behavioral agents remain nonresumable. Behavioral provider failures do not gain a runtime fallback retry.

## Discovery and safety

Locational support is **off by default**. To opt in, start Pi with exactly `PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS=1`. Other values do not enable it. Restart Pi after changing the environment; extension reload alone cannot change the parent process environment.

Without opt-in, no locational discovery, path-based delegation, owner prompt injection, manifest entries, or boundary guards run. Existing locational root, stack, advertisement, scan, and preferred-model environment settings cannot activate the feature. Behavioral children retain this default even with `includeLocationalAgents: true`; stale ownership markers are cleared in their environment. When opted in, children inherit the feature switch, and behavioral-child advertising still requires `includeLocationalAgents: true`. Turning advertising off does not disable opted-in delegation or guards.

Existing session text and historical manifest cards are not removed. Start fresh sessions to avoid retained owner instructions. Opt-in guards are advisory tool-level checks, **not an OS sandbox**. In trusted projects, direct targets also check their ancestors independently of advertisement scanning, including missing suffixes and dangling symlink aliases. Built-in read/write/edit/search paths follow Pi 1.4 file-URL, `@`, Unicode-space and read-fallback semantics on tested Linux paths. Built-in `grep`/`find` ancestor scopes are blocked when they contain a discovered owner; no recursive enforcement scan is added. Active owners and behavioral exemptions remain intact. Untrusted project declarations cannot block direct tools while their delegated agents are unavailable.

Dynamic shell access, literal recursive shell scopes, owners omitted by bounded discovery during recursive searches, filesystem races, custom-tool path semantics, and untested native Windows normalization remain limitations. Filesystem resolution errors fail closed rather than authorizing a lexical substitute. Child extensions must be installed/discoverable; arbitrary parent `-e` flags are not forwarded.

Behavioral definitions resolve from the loaded extension's bundled `agents/`, then user `~/.pi/agent/agents/` (or `$PI_CODING_AGENT_DIR/agents/`), then one trusted project root. The project root is `cwd/.pi/agents/` when that directory exists (including empty); otherwise it is `cwd/.agents/subagents/`. Ancestors are never searched and project roots are not merged.

These exact behavioral trees are excluded from locational discovery, path-based delegation, local owner instructions, and boundary guards. The CWD portable tree remains excluded even when masked by `.pi/agents`. Exclusions follow symlinked containers and direct-child directory symlinks containing `SUBAGENTS.md`, including overridden or invalid definitions. A directory merely named `agents`, or a nested `.agents/subagents` outside those trees, is not exempt. A separate checkout is not the loaded extension's bundled root. No project symlink is supplied. With opt-in enabled, a separate checkout's bundled definitions can therefore be misclassified as locational definitions; default-off avoids that scan and its configuration errors.

When explicitly enabled, `SUBAGENTS.md` remains authoritative for other locational discovery, delegation, and boundaries. A genuine locational ancestor still protects behavioral files beneath it; behavioral classification does not grant access through that ancestor. A locational child cannot delegate to its active root or ancestor stack.

Locational models may declare `model:` candidates or use `PI_SUBAGENT_LOCATIONAL_PREFERRED_MODELS`. If a selected non-caller locational model fails before task work, the child retries once in the same session with the caller model. Context-limit failures are labeled `context_limit`.

Trusted parent TUI sessions show a locational-agent manifest card. Reload, resume, tree navigation, and compaction reuse a visible branch entry or append one when absent. Child sessions, untrusted projects, non-TUI modes, disabled advertisement, and empty discovery show no card.

Delegated children set `PI_ORCHESTRATED_CHILD=1`, recursion depth, and locational advertising/ownership markers. The orchestrated marker suppresses automatic child-session supervisors.

## Settings

Use `/subagent-settings` to configure resumable-session reuse and context threshold.

## Validation

Run from this module after root dependency setup. Host-backed path and usage regressions use the root distribution's installed Pi; remaining tests use deterministic local child fixtures. No live provider is required.

```bash
test_home=$(mktemp -d)
HOME="$test_home" PI_CODING_AGENT_DIR="$test_home/agent" npm run typecheck
HOME="$test_home" PI_CODING_AGENT_DIR="$test_home/agent" npm test
HOME="$test_home" PI_CODING_AGENT_DIR="$test_home/agent" npm pack --dry-run
rm -rf "$test_home"
```
