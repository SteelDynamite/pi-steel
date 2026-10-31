# AGENTS.md

Minimal Pi package.

- Rewrite context only by creating a replacement session with the original as parent; never destructively mutate the current branch.
- Persist block status and source entry references, not duplicate original tool output.
- Keep Pi-compacted blocks read-only.
- Omit prior `system-reminder` custom messages when rewriting because replacement-session startup regenerates them.
- When rewritten context has no assistant message, force `SessionManager` persistence with an empty assistant entry on an inactive root branch; Pi otherwise delays creating the session file.
- Keep arbitrary TUI interaction paired with RPC-supported dialog fallbacks.

```sh
npm install
npm run validate
```
