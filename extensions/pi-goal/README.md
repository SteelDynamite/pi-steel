# pi-goal

Pi extension that adds `/goal`, a session-scoped completion condition that keeps the current agent working until the condition is met.

## Install

```sh
pi install git:github.com/SteelDynamite/pi-goal
```

For local testing:

```sh
pi -e ./index.ts
```

## Usage

Set a goal:

```text
/goal all tests in test/auth pass and npm run lint exits 0
```

Check status:

```text
/goal
```

Clear an active goal:

```text
/goal clear
```

Clear aliases: `stop`, `off`, `reset`, `none`, `cancel`.

## Behavior

- One active goal is allowed per session.
- Setting a goal appends one immutable goal-context message and starts work immediately without changing the system prompt.
- After each completed agent turn, the extension asks the current model to evaluate whether non-supervisor transcript evidence proves the goal is met. Evaluation uses Pi's actionable-boundary context (`event.context.contextMessages`), including earlier handlers' uncommitted context edits, removals, and compaction—not raw history or only the persisted projection.
- Tool call IDs/arguments, result error flags, shell exit/cancellation status, and assistant stop reasons accompany evidence. Aborted/error assistant claims are excluded. Evaluation is tool-free and uses provider-neutral streaming, including virtual-model routing.
- Interrupting a run (Escape or the RPC/SDK abort operation) clears its active goal when the run settles, including interruptions during tools or evaluation. The cleared state persists across reload/resume. Steering messages preserve the goal; dismissing a dialog alone does not clear it.
- Clear, replacement, branch restoration, and shutdown cancel the goal-owned evaluator without aborting unrelated agent work.
- If unmet, the extension atomically appends evaluator guidance and requests one boundary continuation.
- If met, the extension records the goal as achieved and stops looping.
- The evaluator cannot run tools; the agent must surface evidence such as test output, build results, or file counts.

### Clear limitation

`/goal clear` stops future evaluations and cancels an in-flight evaluator. Pi 1.4 does not expose goal-owned cancellation for `sendUserMessage` preflight or an already-returned boundary continuation. An activation awaiting input/authentication, or a continuation waiting on another boundary handler, can still start after clear. Clear deliberately does not abort unrelated work; use Pi's interrupt to stop the active run and clear its goal.

## Bounds

By default, a goal stops after 25 evaluated turns. Include an explicit bound to override it:

```text
/goal npm test exits 0 or stop after 10 turns
```

## Resume and child sessions

Active goals restore with the session. Successful compaction restores a missing immutable context marker before the next request without starting a turn; a legacy resumed session restores it when work next starts. Restoration does not duplicate a surviving marker. Achieved or cleared goals remain as history but do not restart.

Automatic goal behavior is disabled when `PI_ORCHESTRATED_CHILD=1`.

## Development

```sh
npm install
npm run validate
```

Host regressions use the root development Pi 1.4 installation, deterministic local providers, and a subprocess with temporary `HOME` and `PI_CODING_AGENT_DIR`. No live provider or active configuration is used.

## License

MIT
