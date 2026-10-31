# pi-answer maintenance

`pi-answer` is a Pi Coding Agent extension that extracts questions from the last assistant response and lets the user answer them through an interactive Q&A UI.

Read `README.md`, `package.json`, and `index.ts` before making behavior changes.

Key product behavior to preserve:

1. `/answer` and `Ctrl+.` find the last completed assistant message.
2. The extension always asks `openai/gpt-6.1-sol`, independent of the active session model, to extract questions and optional recommended answers as JSON. Use only the unified `openai` provider, with no provider/model fallback; preserve the registered transport API (including `openai-codex-responses`).
3. The UI lets the user answer questions interactively and ghost-fills recommended answers when available.
4. Right Arrow accepts a recommended answer.
5. Compiled answers are sent back into the session.

Maintenance rules:

1. Keep this as a Pi package/extension declared through `package.json#pi.extensions`.
2. Keep package contents aligned with `package.json#files`.
3. Document user-facing command, UI, config, or storage changes in `README.md`.
4. Treat model extraction output as untrusted; keep JSON parsing and fallback handling robust.

Validation:

Use `npm ci` for the locked development dependencies, then run `npm run validate`. If validation cannot run, report why and what was checked instead. For provider changes, also probe the actual Pi extension loader and registry: direct Node imports do not exercise Pi's legacy completion compatibility mapping.
