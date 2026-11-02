# pi-chatgpt

A [pi](https://pi.dev) extension for ChatGPT Codex usage and speed modes.

It provides footer status and requests OpenAI Codex Fast or Ultrafast mode for supported models. Weekly/5-hour quotas, reset times and quota errors are hidden until supported direct-OAuth quota access exists. Speed indicators, session statistics and other extension statuses remain visible. Quota fetching is also disabled: Pi does not expose trustworthy OAuth provenance for the exact resolved credential. Use [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

## Preview

![Footer preview](https://github.com/patlux/pi-chatgpt-limit/releases/download/preview-assets/footer-preview.png)

Historical quota display variants (quota information is currently hidden):

![Footer display variants and color thresholds](https://github.com/patlux/pi-chatgpt-limit/releases/download/preview-assets/footer-variants-readable.png)

## Install

```sh
pi install https://github.com/SteelDynamite/pi-chatgpt.git
```

For a first install, reload pi:

```txt
/reload
```

After updating an extension that is already loaded, use `/reload` first. If it still shows pre-update behavior, fully restart pi.

A source checkout is separate from Pi's Git-installed copy. Run `pi list` to see the configured package path; `/reload` does not copy changes between them. To test this checkout without loading the installed copy or other extensions, run from this directory:

```sh
pi --no-extensions --extension ./index.js
```

When upgrading from `pi-chatgpt-limit`, remove the old package after installing this one. Loading both packages causes duplicate commands, requests, and footer replacements.

## Compatibility

The integration target is Pi 0.99.1 and newer. The declared CI matrix uses exact Pi 0.99.1 and 1.1.0 hosts on Node 24. Local regression tests use Pi 1.4.0's real credential facade with synthetic credentials and verify that no quota credential is resolved or sent. Older hosts such as 0.79.6 predate the unified `openai` OAuth integration and are not covered by that support target. This test matrix does not upgrade your installed Pi, change runtime APIs, or establish live usage-endpoint access.

Only the unified `openai` provider is supported. Obsolete `openai-codex` and numbered variants such as `openai-codex-2` receive no usage requests, speed overrides, or passive diagnostic capture. Select an `openai` model and use its ChatGPT OAuth option in `/login`; do not copy or relabel old credentials. Transport API IDs such as `openai-codex-responses` are distinct from provider IDs and are not rewritten.

Local type declarations and mocked diagnostic tests are not substitutes for host integration coverage. The passive diagnostic's provider-hook delivery is not yet exercised through a real provider stream in CI.

## Usage limits

Quota requests are disabled for all credentials, including OAuth, API keys, and trusted custom endpoints. Pi 1.4.0's `getApiKeyAndHeaders` strips exact-result authentication provenance; its independent cached `isUsingOAuth` check cannot prove that the resolved credential is OAuth. The extension neither resolves quota credentials nor refreshes authentication.

Run:

```txt
/chatgpt
```

This retains weekly, 5-hour, both, or hidden preferences and used, remaining, pace, and reset-time variants for compatibility. Saved preferences do not reenable footer quotas or errors while support is blocked; plan/account details and numeric usage are unavailable.

`/chatgpt-limit` remains as a compatibility alias.

`/chatgpt` → “Show current usage details” explains the provenance blocker and points to ChatGPT Settings → Usage. Session/model events and completed agent runs send no quota requests. Footer settings and speed modes remain available.

No quota values or HTTP-error placeholders appear in the footer, even if cached data exists. The retained parser rejects nonfinite quota values and overflowing reset timestamps rather than treating them as zero. No server error bodies or credentials are displayed.

**Direct OAuth quota remains upstream-blocked.** As checked on 2026-11-02, OpenAI [does not support remaining-quota access for direct-use OAuth](https://github.com/openai/sign-in-with-chatgpt-devkit/issues/3#issuecomment-5936080960). The existing usage probe returned HTTP 401 with that grant. Use [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage); reloading or changing provider names does not fix endpoint authorization. No separate legacy login, Codex installation, or guessed endpoint is a supported workaround.

Retained display formats (not currently shown):

- `W 42%`
- `W 42% · ~2d`
- `W 58% left`
- `5h 25% / W 42%`

Live statuses from other extensions appear alphabetically at the top-right of the first footer row. Long status groups truncate on narrow terminals while preserving the project and session display.

### Passive quota diagnostic (optional)

`extensions/quota-diagnostic.js` is a separate companion, **not loaded by `index.js`**. It does not fix the footer or replace the usage endpoint. Keep your current project's working directory and session; do not switch into this checkout to activate it.

**Preferred: reload in place.** If the checkout is at `repos/pi-chatgpt` under your current project, create a new temporary `.pi/extensions/chatgpt-quota-diagnostic.ts` in that project (do not overwrite an existing file):

```ts
export { default } from "../../repos/pi-chatgpt/extensions/quota-diagnostic.js"
```

Then run `/reload` in the existing, idle Pi session. Pi 0.99.1 discovers project `.ts` extensions and imports their default factory; this re-export preserves the companion's factory. Reload retains the session and cwd. Project resources must already be trusted and enabled (not disabled by `--no-extensions` or resource filters). The shim must be staged by someone authorized to modify that project. No package or settings edits are required.

**Restart alternative:** from the original project cwd, with no shim loaded:

```sh
pi --continue --extension ./repos/pi-chatgpt/extensions/quota-diagnostic.js
```

`--continue` chooses the most recent session for that cwd, not necessarily the session you intended if several exist. To select the exact session, replace it with `--session /absolute/path/to/the/intended-session.jsonl`, still launching from the original cwd. Adjust the extension path to your checkout; an absolute extension path also avoids changing cwd. Do not load both the shim and the CLI companion. Neither method replaces or updates the Git-installed package.

1. While idle on an OpenAI model authenticated with ChatGPT OAuth, run `/chatgpt-quota-diagnostic arm`.
2. Continue your normal work with the request you already intended. Do not send a diagnostic-only prompt.
3. After it finishes, run `/chatgpt-quota-diagnostic show` and copy the report if needed.
4. Run `/chatgpt-quota-diagnostic off` to clear memory. Remove only the temporary shim and `/reload`, or restart without `--extension` if using the CLI method.

Capture stops at the next provider request or `agent_end`, so tool continuations are excluded. Model changes, reload, and shutdown clear it. The diagnostic makes no requests, resolves no credentials, changes no request data, and writes no files or session entries. It retains only hook counts and these allowlisted fields in memory, displayed on demand:

- Headers: `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}` (latest response only, including an empty response).
- Events with type exactly `codex.rate_limits`: `rate_limits.{primary,secondary}.{used_percent,window_minutes,reset_at}` (latest event only).

A single logical request can produce multiple response hooks during retries. Header values are replaced, never merged across responses; hook counts remain cumulative. The latest quota event is retained independently, so it is not guaranteed to describe the same attempt as the latest headers.

Values must be finite nonnegative numbers; window minutes and Unix reset seconds must be safe integers. Header numeric strings are converted to numbers. Malformed values appear only as `"invalid"`; missing fields are omitted, not interpreted as zero. Credentials, account identifiers, plan metadata, content, bodies, other events, and complete headers are never retained or displayed.

The candidate schema comes from [OpenAI Codex's parser](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs). Pi 0.99.1 exposes `after_provider_response` before stream consumption and `provider_stream_event` before normalization. This does **not** confirm that public-API OAuth responses include Codex quota metadata. Empty quota objects with positive hook counts mean those fields were not observed; zero hook counts mean no eligible hook was observed, not zero usage. The response hook lacks model identity, so it is gated by the active model's OAuth status; stream events additionally must match that model. No quota-to-footer mapping is enabled without live evidence.

**Observed limitation (Pi 0.99.1):** one user-reported normal request on `openai` with direct-use ChatGPT OAuth returned `responseHooks=1`, `streamHooks=30`, `quotaEvents=0`, `headers={}`, and `streamQuota={}`. The hooks fired, but this request exposed no allowlisted quota metadata. Together with the usage endpoint's previously observed HTTP 401 for that credential, there is currently no verified path to restore numeric quota display for it. This is evidence from one request, not proof that every credential or future response lacks quota metadata; it does not mean usage is zero. Check [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage) for account usage.

## Speed modes

`/fast` selects one of three modes:

- **Standard** sends no `service_tier` override.
- **Fast** sends `service_tier: "priority"` for GPT-5.4, GPT-5.5, GPT-5.6 Sol (`gpt-5.6-sol`), GPT-5.6 Terra (`gpt-5.6-terra`), and GPT-5.6 Luna (`gpt-5.6-luna`).
- **Ultrafast** sends `service_tier: "ultrafast"` for GPT-6 Astra (`gpt-6-astra`) and GPT-6.1 Sol (`gpt-6.1-sol`), as supported by [OpenAI's Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode).

```txt
/fast temporary [standard|fast|ultrafast]   Select for this session
/fast persistent [standard|fast|ultrafast]  Select now and for future sessions
/fast off                                   Select Standard persistently
/fast status                                Show selected and effective mode
```

Omitting the mode from `temporary` or `persistent` still selects Fast, preserving the existing commands. Fast and Ultrafast require ChatGPT OAuth on `openai`; API-key sessions receive no override. Unsupported models receive no override and the command reports why. The footer shows `Fast` or `Ultrafast` only when the selected mode is effective for the active model.

Selection is not gated by reported plan metadata because eligible Enterprise and Edu accounts may qualify. OpenAI remains responsible for account eligibility and can reject an unavailable tier.

Accelerated modes can consume ChatGPT credits faster. OpenAI currently documents 2× Standard consumption for GPT-5.4 and 2.5× for GPT-5.5. For the GPT-5.6 models, OpenAI documents 1.5× speed and only “increased usage,” without an exact usage multiplier.

The selected mode propagates to new subprocesses as `PI_CHATGPT_SPEED=standard|fast|ultrafast`. `PI_CHATGPT_FAST=1|0` remains the effective, model-aware compatibility signal (`1` for effective Fast or Ultrafast). Selection survives model switches: unsupported models receive no override, but the selected speed remains available when switching back to a supported model. Child processes that inherit these variables and load this extension retain the selected speed even when they choose a different model, including Astra → Sol 6.1 Ultrafast. Previous values are restored on shutdown. A temporary selection is not written to disk and is lost on reload, session replacement, or process exit.

## Configuration and migration

Settings persist globally in:

```txt
~/.pi/agent/chatgpt.json
```

The file stores footer preferences, `speedMode`, and the compatibility `fastMode` boolean. Existing `fastMode: true|false` values load as Fast or Standard and migrate on the next settings write. On first load, legacy `~/.pi/agent/chatgpt-limit.json` settings are migrated without deleting the old file. Legacy session footer entries and `/chatgpt-limit` continue to work.

## Endpoint and security

The retained endpoint configuration targets (no requests are currently sent):

```txt
GET https://chatgpt.com/backend-api/wham/usage
```

Quota transport fails closed before credential resolution. Reenabling it requires both a supported upstream quota source and a host contract binding typed OAuth provenance to the exact model-level credential, including overrides. Token claims, cached OAuth status, and human-readable provider source labels are not substitutes. Authentication refresh remains host-owned.

Queued quota work and pending initial usage menus are invalidated on shutdown/session replacement before accessing stale contexts. This does not establish complete lifecycle isolation for already-open configuration dialogs or global configuration writes; those remain tracked debt.

Account details, displayed model/provider names, and project/session labels have terminal escape sequences and control characters removed before rendering. Provider-bound identifiers and payloads are unchanged; trusted extension status styling is preserved.

`CHATGPT_BASE_URL` can override the endpoint path on that origin. To use a non-ChatGPT testing or proxy URL, set `CHATGPT_TRUST_CUSTOM_BASE_URL=1` only for trusted infrastructure. The legacy `CHATGPT_LIMIT_TRUST_CUSTOM_BASE_URL` name remains supported.

Extensions run with local user permissions and can access pi auth storage. Review extensions before installing them.

## Publish

```sh
npm login
npm publish --access public
```

## License

MIT
