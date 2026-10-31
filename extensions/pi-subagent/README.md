# Pi Subagent

Foreground-managed behavioral and locational Pi-agent delegation. Each `subagent` call runs one isolated Pi child and returns its result; built-in `bash` owns shell execution.

## Features

- Behavioral discovery precedence: bundled, user, then trusted-project definitions.
- Locational `SUBAGENTS.md` discovery, source-root boundaries, and recursion guards.
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

mkdir -p ~/.pi/agent/prompts
ln -sf "$(pwd)/prompts/implement.md" ~/.pi/agent/prompts/implement.md
```

### Runtime requirements

Delegation requires the hosting `@earendil-works/pi-coding-agent` package to include its runnable CLI, not just an embedded SDK. Node.js and Bun script hosts use that package's declared `bin.pi`; packaged Bun Pi executables use the adjacent Pi distribution. SDK host entrypoints (including bots) are never reused as worker scripts. Missing or unidentifiable CLI installations fail before spawning; there is no `PATH` fallback. Source-only SDK builds need a built CLI. Child environment inheritance is unchanged, not credential isolation.

## Tool

`subagent` accepts exactly:

```json
{
  "id": "scout",
  "session": "new",
  "task": "Find authentication code",
  "contextDocs": ["/absolute/product-guidance.md"],
  "includeLocationalAgents": false
}
```

`id`, `session`, and `task` are required. `contextDocs` and `includeLocationalAgents` are optional. Use `resume` only when the prior result requests it. Behavioral agents inherit the caller directory; locational-agent ids are absolute or caller-relative folders containing `SUBAGENTS.md` and run from that source root.

Use ordinary `bash` calls for shell commands and sibling/later `subagent` calls for concurrent/sequential delegation.

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

`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. When declared, every new and resumed child receives `--thinking <level>`, overriding that child's startup and saved-session setting. Omit it to preserve Pi's existing child defaults. Callers cannot override it through `subagent`; Pi still clamps levels to selected-model support.

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

These explicit targets use `openai` even when the matching caller uses another provider. All unrelated callers retain the existing models (scout `openai/gpt-6-luna`, worker `openai/gpt-6.1-sol`, reviewer `openai/gpt-6-astra`) and omitted thinking. Speed and thinking are independent; inherited environment, including `PI_CHATGPT_SPEED`, passes through unchanged. Ultrafast service still depends on the child's provider, authentication, and `pi-chatgpt` support.

Rules are reevaluated for every delegation, including resume. Effective model and declared thinking are passed to the child and reported in results; Pi may clamp thinking to model support. If a custom resumable agent switches to an unmatched rule with omitted thinking, no thinking flag is sent: Pi's saved effort may persist. No restoration mechanism is added. Bundled behavioral agents remain nonresumable. Behavioral provider failures do not gain a runtime fallback retry.

## Discovery and safety

Behavioral definitions resolve from the loaded extension's bundled `agents/`, then user `~/.pi/agent/agents/` (or `$PI_CODING_AGENT_DIR/agents/`), then one trusted project root. The project root is `cwd/.pi/agents/` when that directory exists (including empty); otherwise it is `cwd/.agents/subagents/`. Ancestors are never searched and project roots are not merged.

These exact behavioral trees are excluded from locational discovery, path-based delegation, local owner instructions, and boundary guards. The CWD portable tree remains excluded even when masked by `.pi/agents`. Exclusions follow symlinked containers and direct-child directory symlinks containing `SUBAGENTS.md`, including overridden or invalid definitions. A directory merely named `agents`, or a nested `.agents/subagents` outside those trees, is not exempt. A separate checkout is not the loaded extension's bundled root. This checkout declares its `agents/` through the `.agents/subagents -> ../agents` project-root symlink, so an installed copy also recognizes these definitions as behavioral.

`SUBAGENTS.md` remains authoritative for other locational discovery, delegation, and boundaries. A genuine locational ancestor still protects behavioral files beneath it; behavioral classification does not grant access through that ancestor. A locational child cannot delegate to its active root or ancestor stack.

Locational models may declare `model:` candidates or use `PI_SUBAGENT_LOCATIONAL_PREFERRED_MODELS`. If a selected non-caller locational model fails before task work, the child retries once in the same session with the caller model. Context-limit failures are labeled `context_limit`.

Trusted parent TUI sessions show a locational-agent manifest card. Reload, resume, tree navigation, and compaction reuse a visible branch entry or append one when absent. Child sessions, untrusted projects, non-TUI modes, disabled advertisement, and empty discovery show no card.

Delegated children set only `PI_ORCHESTRATED_CHILD=1`. This suppresses automatic child-session supervisors.

## Settings

Use `/subagent-settings` to configure resumable-session reuse and context threshold.

## Validation

```bash
npm run typecheck
npm test
npm pack --dry-run
```
