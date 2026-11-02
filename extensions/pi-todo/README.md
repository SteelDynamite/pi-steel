# pi-todo

A stateful todo-list extension for [pi](https://github.com/earendil-works/pi).

Based on pi's [`todo.ts` extension example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/todo.ts).

## Install

```bash
pi install git:github.com/SteelDynamite/pi-todo
```

For local testing:

```bash
pi -e ./index.ts
```

## Usage

The extension adds a branch-aware `todo` tool for the agent:

- `list`
- `add` with `items: string[]`, optional `replace: boolean`, and optional `title: string`
- `complete` with integer `id` and `state: "done" | "failed"`
- `clear`

Examples:

```json
{ "action": "add", "items": ["Inspect code", "Run tests"], "replace": true, "title": "Inspect todo architecture" }
{ "action": "complete", "id": 1, "state": "done" }
{ "action": "add", "items": ["Follow-up fix"] }
{ "action": "list" }
{ "action": "clear" }
```

Use `replace: true` for a fresh plan when the old list is obsolete. Include `title` when creating a fresh plan; pi-todo persists it in todo state and sets it as the Pi session name. Omit `title` to keep the existing title/session name. Omit `replace` to append follow-up work.

`clear` removes todo items but preserves the title/session name.

In TUI mode, todos appear automatically in a widget above the editor when the list is non-empty or a title exists. When a title exists, the widget header displays `● <title>`. The title remains visible even after todo items are cleared. The top pending todo animates while the agent is active, then returns to pending when waiting for user input. The widget retains five leading done/failed items, then scrolls one row per additional leading done/failed item to reveal later work; an earlier pending item blocks scrolling. If all todos are done or failed for 4 turns, todo items auto-hide without deleting state; a title, when present, remains visible. In RPC/Paseo, JSON, and print modes, the todo tool remains available but widget and animation work is skipped.

Terminal control characters in todo text and titles are displayed as literal `\uXXXX` escapes in this extension's widgets and tool renderers, including when restoring older sessions. Stored todo text/title, tool output, and titles passed to Pi's session naming API remain unchanged; this escaping does not protect Pi's own session-name displays.

Before a successfully completed run settles, if pending todos appear before later done/failed todos, pi-todo appends a `<system-reminder>` asking the agent to mark/reorder them so remaining pending todos stay at the end. At most one reminder continuation is allowed per submitted prompt, even if the list changes. Aborted/error runs and orchestrated children (`PI_ORCHESTRATED_CHILD=1`) never trigger these continuations. This uses Pi 1.4's outcome-aware `agent_before_settle` boundary rather than queued steering.

Successful mutations persist immediately through Pi's `appendEntry()` as branch-local `pi-todo-state` entries. Direct and nested tool access remain available; nested calls do not need standalone transcript results to survive reload/resume. Tool-result details retain display snapshots marked `stateEntry: true`; reconstruction ignores these potentially delayed echoes and reads custom snapshots and older unmarked todo results in branch order. Invalid stored todo items are skipped; later valid snapshots still restore normally. Missing required action fields and nonexistent IDs return failed tool status without changing saved state.

On reload/resume/tree navigation, pi-todo restores the title as the Pi session name. The widget auto-hide timer is process-local presentation state and resets on navigation, giving completed lists a fresh four-turn grace period; title-only widgets remain visible.

## Development

```bash
# From the Steel workspace, install root development dependencies first (npm ci).
# Then run in extensions/pi-todo:
npm run validate
```

Validation includes deterministic Pi 1.4 host tests for direct/nested calls, delayed result ordering, disk reopen, reload/tree restoration, failed status, cancellation, and child suppression. Host tests run in isolated homes with a local provider; they require the workspace's host dependency, not a live account.

## License

MIT
