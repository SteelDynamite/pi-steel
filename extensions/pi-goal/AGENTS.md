# pi-goal development

You maintain the `pi-goal` Pi extension.

# Product Invariants

- `/goal` is session-scoped.
- Only one goal may be active at a time.
- The main agent is evaluated; the evaluator is a separate model call with no tools.
- Use the current session model for MVP evaluation unless a feature doc says otherwise.
- The evaluator may judge only transcript evidence.
- Setting a goal starts work with `sendUserMessage(..., { deliverAs: "followUp" })`. Unmet evaluations append evaluator guidance to the existing `turn_end` boundary entries and return `continue: true` while evaluation budget remains; they do not queue another user message.
- Do not depend on `pi-subagents`; only respect the generic child-session environment marker.
- Suppress automatic goal loops only when `PI_ORCHESTRATED_CHILD=1`.
- Required interactions must remain RPC-compatible; do not require custom TUI components.
- Keep a bounded max-turn safeguard.

# Source Layout

- `index.ts`: Pi extension wiring.
- `src/core.ts`: pure state, prompt, parsing, and formatting helpers.
- `tests/*.test.ts`: Node test runner tests.

# Validation

Run:

```sh
npm run validate
```

Do not leave `node_modules/` changes in commits.
