# pi-chatgpt maintenance

`pi-chatgpt` is a Pi extension package for ChatGPT Codex usage and speed modes.

Read `README.md`, `package.json`, `index.js`, and `extensions/chatgpt.js` before making behavior changes.

Key product behavior to preserve:

1. Hide all footer quota values, reset times and quota-error placeholders until supported direct-OAuth access exists. Preserve speed indicators, session statistics and other extension statuses.
2. `/chatgpt` retains saved display preferences and explains unavailable usage with the ChatGPT Settings → Usage fallback; `/chatgpt-limit` remains a compatibility alias.
3. Preserve weekly, 5-hour, both, hidden, used/remaining/pace percent and reset-time preferences without letting them reenable blocked quota display.
4. Settings persist globally in `~/.pi/agent/chatgpt.json`; legacy `chatgpt-limit.json` settings migrate automatically.
5. `/fast temporary|persistent [standard|fast|ultrafast]`, `/fast off`, and `/fast status` preserve legacy Fast commands; Fast injects `service_tier: "priority"` for its supported Codex models, while Ultrafast injects `service_tier: "ultrafast"` only for `gpt-6-astra` and `gpt-6.1-sol`. Both modes require ChatGPT OAuth. Do not gate either mode by plan metadata.
6. The footer labels only an effective `Fast` or `Ultrafast` selection. Unsupported selections provide clear command feedback and send no override.
7. Selected speed propagates through `PI_CHATGPT_SPEED=standard|fast|ultrafast`; effective acceleration continues to propagate through `PI_CHATGPT_FAST=1|0`. Restore both previous values on shutdown.
8. Persistent config stores `speedMode` plus the compatibility `fastMode` boolean; normalize existing booleans to Fast/Standard without breaking legacy files.
9. Quota transport stays disabled before credential resolution. Restoration requires a supported quota source and trustworthy OAuth provenance for the exact resolved credential; cached OAuth status is insufficient.
10. Preserve `CHATGPT_BASE_URL` validation for trusted testing/proxy infrastructure; it must not reenable disabled quota transport.
11. Never support or select obsolete `openai-codex` providers, including numbered variants. Negative regression fixtures may name them. Preserve transport API IDs such as `openai-codex-responses`; they are not provider IDs. Do not migrate credentials by renaming their provider.
12. Track upstream quota availability in the existing direct-OAuth follow-up document; no automatic polling or scheduled checks. Keep the Settings → Usage fallback outside the footer. Do not introduce legacy login, require Codex, or guess authenticated endpoints.

Installed Pi 0.99.1 routing: `pi-ai/providers/openai` uses `openai-responses` at `https://api.openai.com/v1` for both API keys and ChatGPT OAuth (`auth/oauth/openai-chatgpt`). `ModelRegistry.isUsingOAuth` reads the runtime's effective auth snapshot; `getApiKeyAndHeaders` resolves the active credential. Do not identify OAuth from `model.api`, `model.baseUrl`, or JWT claims. The cached OAuth check is not exact-result credential provenance: the known PCG-001 race can resolve an API key after a stale OAuth check. Provider removal does not retire that security debt or PCG-002 session-ownership debt.

Maintenance rules:

1. Keep package entry declarations in `package.json#pi.extensions` accurate.
2. Keep published package contents aligned with `package.json#files`.
3. Preserve formatting expectations; this repo uses Prettier.
4. Do not commit screenshots or generated image artifacts. Use hosted GitHub release assets for README/announcement images.
5. Document user-facing command, footer, config, endpoint, privacy, or security changes in `README.md`.
6. Treat remote endpoint responses as untrusted and handle missing/malformed account or quota data defensively.
7. Preserve release notes/announcement guidance below unless the user explicitly changes it.

Package/release basics:

1. CI runs on pushes to `main` and pull requests via `.github/workflows/ci.yml`.
2. CI verifies formatting, JS type checking, e2e tests, and `npm pack --dry-run`.
3. GitHub release publishing triggers `.github/workflows/publish.yml`, which runs `npm publish --access public --provenance`.
4. After creating a release, verify:
   1. GitHub Actions publish workflow succeeded.
   2. `npm view pi-chatgpt version` shows the released version.

Announce notable releases in:

1. GitHub Releases at `https://github.com/SteelDynamite/pi-chatgpt/releases` with concise notes, install/update command, and preview asset links.
2. The existing r/PiCodingAgent thread: `https://www.reddit.com/r/PiCodingAgent/comments/1t17kz8/i_made_a_pi_extension_that_shows_chatgpt_codex/`.

Keep Reddit updates short: version, key changes, release notes link, and:

```sh
pi install https://github.com/SteelDynamite/pi-chatgpt.git
```

If attaching Reddit screenshots, use Chrome MCP. If Reddit cannot attach an image to an existing comment, reply to the update comment with the image.

Current v0.2.0 announcement references:

1. Release: `https://github.com/patlux/pi-chatgpt-limit/releases/tag/v0.2.0`
2. Reddit update comment: `https://www.reddit.com/r/PiCodingAgent/comments/1t17kz8/comment/oksq06u/`
3. Reddit screenshot reply: `https://www.reddit.com/r/PiCodingAgent/comments/1t17kz8/comment/oksqdwa/`

Validation:

Run relevant checks after changes:

```sh
npm test
npm run typecheck
npm run format:check
```

If validation cannot run, report why and what was checked instead.
