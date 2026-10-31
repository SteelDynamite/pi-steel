# pi-system-reminders maintenance

`pi-system-reminders` discovers reminder files and injects reactive `<system-reminder>` steering messages during agent sessions.

Read `README.md`, `package.json`, `index.ts`, and relevant tests/examples before making behavior changes.

Key product behavior to preserve:

1. No reminders are active by default after install.
2. Reminder discovery loads top-level `*.ts` files and one-level `*/index.ts` files from global `~/.pi/agent/reminders/` and project `.pi/reminders/`.
3. Project reminders override global reminders with the same name.
4. Reminder files export a default function receiving Pi `ExtensionAPI`.
5. Returned reminders declare event(s), `when`, `message`, optional `cooldown`, and optional `once`.
6. Matching reminders inject `<system-reminder>` messages with `deliverAs: "steer"` and `triggerTurn: true` by default; reminders may set `triggerTurn: false`.
7. Broken reminders are reported at startup and visible through `/reminders` diagnostics.
8. Example reminders in `examples/` should remain copyable into `.pi/reminders/`.

Maintenance rules:

1. Keep package entry declarations in `package.json#pi.extensions` accurate.
2. Keep published package contents aligned with `package.json#files` and `.npmignore`.
3. Treat reminder files as arbitrary user code; preserve security warnings in docs.
4. Keep examples small, practical, and documented in the README table.
5. Document changes to discovery, event support, reminder shape, diagnostics, or examples in `README.md`.
6. Be explicit about branch/session caveats when reminders keep runtime state in closures.

Validation:

Run relevant checks after changes:

```sh
npm run typecheck
npm test
npm run test:pack
```

If validation cannot run, report why and what was checked instead.
