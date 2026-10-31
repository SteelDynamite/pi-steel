# pi-prompt-suggestions maintenance

`pi-prompt-suggestions` is a Pi extension that generates a natural next-prompt suggestion after an agent response and displays it as ghost text or below the editor. Preserve non-TUI exclusions, autocomplete behavior, and custom-editor compatibility.

Read `README.md`, `package.json`, `src/index.ts`, `index.ts`, `prompts/suggestion-system-prompt.md`, and relevant tests before making behavior changes.

Key product behavior to preserve:

1. Generate a short next-prompt suggestion after `agent_end`.
2. Show suggestions as ghost text by default or below the editor when configured.
3. Accept a visible suggestion with Right Arrow when the editor is empty.
4. Submit a visible suggestion with Enter when the editor is empty.
5. Only let Tab accept suggestions when `acceptTab` is enabled; otherwise leave autocomplete behavior unchanged.
6. Reject bad model outputs such as questions, labels, markdown, meta text, errors, evaluative replies, and overlong suggestions.
7. Support global config at `~/.pi/agent/extensions/prompt-suggestions.json` and project config at `.pi/prompt-suggestions.json`, with project config overriding global config.
8. Fall back to the active Pi model when configured model selection is missing or invalid.

Maintenance rules:

1. Keep package entry declarations in `package.json#pi.extensions` accurate.
2. Keep published files aligned with `package.json#files`.
3. Treat model output as untrusted; keep sanitation and length limits strict.
4. Be careful with editor replacement in ghost mode because it can conflict with other custom-editor extensions.
5. Document user-facing config, privacy/cost, display, keybinding, prompt, or logging changes in `README.md`.
6. Do not enable debug logging by default; debug output can include conversation context.

Validation:

Run `npm run validate` after changes when dependencies are installed. If validation cannot run, report why and what was checked instead.
