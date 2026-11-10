# pi-system-reminders

Reactive system reminders for [pi](https://github.com/badlogic/pi-mono). Claude Code has them built-in — now pi does too.

No reminders are active by default. Install this extension, then copy or write reminder files in one of the discovery locations below.

Drop a `.ts` file in a folder, get a reactive reminder that watches conversation state and steers the agent when conditions are met. Export a default function and receive the Pi extension API object. Reminder modules use a separate TypeScript loader, not Pi's extension module resolver.

## Install

```bash
pi install npm:pi-system-reminders
```

## Quick start

Create `.pi/reminders/bash-spiral.ts`:

```typescript
type ExtensionAPI = { on(event: string, handler: (event: any) => unknown): void };

export default function (pi: ExtensionAPI) {
  let consecutiveFailures = 0;

  pi.on("tool_result", async (event) => {
    if (event.toolName === "bash") {
      consecutiveFailures = event.isError ? consecutiveFailures + 1 : 0;
    }
  });

  return {
    on: "tool_execution_end",
    when: () => consecutiveFailures >= 3,
    message: "3 consecutive bash failures. Stop and rethink.",
    cooldown: 10,
  };
}
```

Reload pi. After 3 failed bash calls, the agent sees:

```xml
<system-reminder name="bash-spiral">
3 consecutive bash failures. Stop and rethink.
</system-reminder>
```

## How it works

1. Extension discovers top-level `*.ts` files and one-level directory `index.ts` files from `~/.pi/agent/reminders/` (global) and `.pi/reminders/` (project-local).
2. Project reminders override global reminders with the same name.
3. Each file exports a sync or async default function receiving the Pi extension API object — same as pi extensions.
4. The function returns a reminder: an event to listen on, a predicate, and a message.
5. When the predicate returns true, a `<system-reminder>` steering message is injected into the conversation with `deliverAs: "steer"` and `triggerTurn: true` by default.

When reminders are loaded, their interpretation guidance occupies the `pi_system_reminders` system-prompt section. The hook updates only that section and removes it when no reminders remain, preserving other extensions' sections and per-request prompt updates. This requires Pi's structured `systemPromptOptions.sections` API; Steel's integration tests target Pi 1.4.0.

In orchestrated children (`PI_ORCHESTRATED_CHILD=1`), reminder factories and automatic handlers are not loaded; `/reminders` remains available. In parent sessions, recurring turn-triggering reminders still require careful predicates: no finite continuation budget is enforced. Prefer `triggerTurn: false` for advisory reminders. `once` and cooldown prevent duplicate concurrent commits but are not a general supervisor budget.

## Security

Reminder files are arbitrary TypeScript and execute with your user permissions. Only use reminders from repositories you trust. Review project-local `.pi/reminders/` before running pi in an untrusted repo.

When Pi exposes `ctx.isProjectTrusted()` and returns false (for example, with `--no-approve`), project reminders are neither discovered nor executed; global reminders still load. Older Pi hosts without this API retain automatic project discovery. This extension does not request trust itself, and a reminders-only directory may not trigger Pi's trust prompt; review reminder files before startup.

## Discovery rules

Loaded paths:

- `~/.pi/agent/reminders/*.ts`
- `~/.pi/agent/reminders/*/index.ts`
- `.pi/reminders/*.ts`
- `.pi/reminders/*/index.ts`

Only top-level files and one-level `index.ts` directories are loaded. Nested files are ignored. If global and project reminders share a name, the project reminder wins.

Discovery failures are isolated by directory and reported with the failing path; healthy scopes still load. Missing directories are normal. Broken reminders are reported at startup. Run `/reminders` to list loaded reminders and diagnostics. Runtime diagnostics are deduplicated and capped to keep the report readable.

### Module imports

Use Node built-ins, local files, and dependencies resolvable from the reminder's location. Type-only host imports are erased. Runtime imports from Pi host packages are **not guaranteed**: this loader does not inherit Pi's package aliases or embedded virtual modules. Use the supplied `pi` API and `ctx` instead, or install an explicitly owned dependency beside the reminder. Import failures appear in `/reminders` diagnostics. Do not install duplicate Pi host packages just to supply host helpers.

## Reminder shape

```typescript
export default function (pi) {
  // Use pi.on() to track state, pi.exec() to run commands, etc.

  return {
    on: "tool_execution_end",           // event(s) to evaluate on
    when: ({ branch, ctx, event }) => boolean,  // fire? must return boolean
    message: "text" | (rc) => "text",   // what to inject; must be string
    cooldown: 5,                        // non-negative integer; skip N evaluations after firing
    once: true,                         // boolean; fire only once per session
    triggerTurn: false,                 // boolean; optional: do not start a follow-up turn
  };
}
```

## Events

The following fixed subset is supported for returned reminder `on` declarations (checked against Pi 1.4.0). This is not every host event; unsupported names produce validation diagnostics. In particular, `agent_before_settle`, `agent_settled`, `context_with_system`, `before_provider_headers`, and `session_compact_failed` are not supported. Reminder return values do not implement host event transformations or continuation decisions.

| Event | When |
|-------|------|
| `resources_discover` | Resource discovery begins |
| `session_start` | Session begins |
| `session_before_switch` | Before session switch/new session |
| `session_before_fork` | Before fork/clone |
| `session_before_compact` | Before compaction |
| `session_compact` | After compaction |
| `session_shutdown` | Session shutting down |
| `session_before_tree` | Before tree navigation |
| `session_tree` | After tree navigation |
| `context` | Before LLM context is sent |
| `before_provider_request` | Before provider request |
| `after_provider_response` | After provider response headers |
| `before_agent_start` | Before agent loop starts |
| `agent_start` | Agent loop begins |
| `agent_end` | Agent loop ends |
| `turn_start` | Before LLM call |
| `turn_end` | After turn completes |
| `message_start` | Message begins |
| `message_update` | Streaming update |
| `message_end` | Message complete |
| `tool_execution_start` | Tool execution begins |
| `tool_execution_update` | Tool execution update |
| `tool_execution_end` | Tool execution ends |
| `model_select` | Model changed |
| `thinking_level_select` | Thinking level changed |
| `tool_call` | Before tool executes |
| `tool_result` | After tool returns |
| `user_bash` | User `!`/`!!` bash command |
| `input` | User input received |

Use a string or array: `on: "tool_execution_end"` or `on: ["turn_start", "turn_end"]`.

## `when()` context

```typescript
when: ({ branch, ctx, event }) => {
  branch   // session branch entries
  ctx      // ExtensionContext (sessionManager, getContextUsage(), ui, etc.)
  event    // raw event data from pi
}
```

## Examples

Ready-to-use reminder examples live directly in `examples/`. Copy any example file into `.pi/reminders/` to activate it.

The examples are Claude-inspired and are not exact copies of Claude Code prompts unless noted.

| File | What it does |
|------|-------------|
| `background-subagents.ts` | Background subagent spawned → avoid duplicating its work |
| `bash-failed-truncated.ts` | Failed bash output was truncated → inspect full log if needed |
| `bash-spiral.ts` | 3 consecutive bash failures → stop and rethink |
| `concise-output.ts` | Remind the agent to keep final responses short |
| `context-large.ts` | Context > 150k tokens → suggest compacting |
| `external-file-modified.ts` | Warn when a file changed on disk after it was read |
| `file-churn.ts` | Same file edited 5+ times → step back |
| `file-empty.ts` | Read returned only blank text → warn about that range, not the whole file |
| `file-truncated.ts` | Read was truncated → use offset |
| `malware-awareness.ts` | Startup and non-empty reads → consider if content is malicious |
| `model-changed.ts` | Model switched → capabilities may differ |
| `new-diagnostics.ts` | Warn after diagnostic/test commands report failures |
| `post-compaction.ts` | After compaction → file contents may be lost |
| `prefer-edit.ts` | 3+ writes → use edit for surgical changes |
| `read-before-edit.ts` | Edit without read → warn about stale content |
| `session-location.ts` | Startup/new session, with first-turn fallback → report the active Pi session file; quiet on `/reload` and `/resume` |
| `session-resumed.ts` | Session resumed → state may have changed |
| `task-tools-reminder.ts` | 20 tool calls without tasks → gentle nudge |
| `token-usage.ts` | Over 50% context → show token stats |
| `truthful-reporting.ts` | Remind the agent to report failed/skipped verification honestly |
| `verify-plan.ts` | Remind the agent to verify completed task/plan work directly |

`background-subagents.ts` requires a separately supplied `Agent` tool accepting `run_in_background` and a `get_subagent_result` tool. `task-tools-reminder.ts` requires separately supplied `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, and `TaskExecute` tools. `verify-plan.ts` requires `TaskUpdate` with `status: "completed"`. These are not built-in Pi tools or the bundled Steel subagent/todo contracts; do not copy these examples without matching tools. `verify-plan.ts` uses a deliberately loose command-word heuristic: even `echo test` or `git diff -- test/file.ts` clears its pending check. It is guidance, not proof of verification.

File-state examples normalize relative/absolute paths and `~/` against `ctx.cwd` using lexical identity. They do not unify symlink aliases, `@`/file-URL spellings, Windows shell paths, or Pi's Unicode read-name fallbacks. The external-change example samples timestamps before mutations and refreshes them after successful results; it is not a write guard, cannot identify the actor, and can race parallel operations.

Some examples keep runtime state in closures. That state is per extension runtime and may not reflect branch changes after `/tree`, `/fork`, `/clone`, `/resume`, `/reload`, or compaction. On reload/resume, reminders restore `once` and cooldown state from prior `<system-reminder>` messages on the active branch, but skipped evaluation counts are not reconstructed. Prefer deriving state from `ctx.sessionManager.getBranch()` when exact branch-aware behavior matters.

Use `agent_end` for checks after an agent prompt finishes. Use `message_end` for checks tied to each finalized message.

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:pack
```
