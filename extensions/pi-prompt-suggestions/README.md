# pi-prompt-suggestions

Pi extension that suggests a natural next prompt after an agent response.

Disclaimer: this is clanker slop.

Behavior:

- Generate a short next-prompt suggestion after `agent_end` in TUI mode.
- Skip non-TUI modes such as RPC, JSON, and print mode.
- Show it as ghost text in the input editor by default.
- Optionally show it below the input editor.
- Accept it with Right Arrow when the editor is empty.
- Submit it immediately with Enter when the editor is empty.
- Optionally accept it with Tab when the editor is empty.
- Leave Tab/autocomplete behavior unchanged unless `acceptTab` is enabled.
- Reject common bad model outputs such as questions, meta text, labels, errors, markdown formatting, evaluative replies, and overlong suggestions.
- Reject terminal controls before display or acceptance. Ordinary edge whitespace is trimmed; embedded controls and line separators are rejected, while valid Unicode remains supported.
- Dismiss suggestions and cancel pending generation on any non-acceptance editor input, including paste, history, navigation, and encoded Unicode input.

## Privacy and cost

In TUI mode after each `agent_end`, this extension sends a condensed slice of the just-finished conversation to `openai/gpt-5.6-terra` by default. A configured suggestion model overrides that default; an invalid configured model falls back to the active Pi model. That request can include recent user text, assistant text, and tool-call names. Treat it like any other model call: it may incur provider cost and may send conversation context to that provider.

Non-TUI modes, including RPC/Paseo, JSON, and print mode, are skipped so the extension does not generate suggestions or spend tokens where the editor UI cannot use them.

Generation runs independently of Pi's awaited completion lifecycle. New work, input, tree navigation, compaction, model selection, and shutdown invalidate pending results and signal cancellation. Providers that ignore cancellation may continue upstream work; there is currently no generation deadline. Failed or aborted responses are not displayed. Current Pi's model registry handles virtual models and resolved authentication/routing; older hosts use the compatibility authentication facade.

If `PI_PROMPT_SUGGESTIONS_DEBUG=1` is set, debug details are shown in the UI and appended to `next-suggestion-debug.log` in the current working directory. Controls and line/paragraph separators in debug details are escaped as literal `\uXXXX` text before display and logging. Disable debug logging before working with sensitive prompts.

## Install

From npm:

```bash
pi install npm:pi-prompt-suggestions
```

From GitHub:

```bash
pi install git:github.com/SteelDynamite/pi-prompt-suggestions
```

## Configuration

By default, suggestions use `openai/gpt-5.6-terra`. Authenticate the `openai` provider through Pi's `/login openai` (ChatGPT subscription or API key).

Optional global config:

```text
~/.pi/agent/extensions/prompt-suggestions.json
```

Optional project config:

```text
.pi/prompt-suggestions.json
```

Project config overrides global config. Config is reread after each `agent_end`; model overrides take effect on the next completed turn without reloading.

```json
{
  "enabled": true,
  "acceptTab": false,
  "display": "ghost",
  "model": "openai/gpt-5-mini",
  "maxTokens": 256,
  "maxChars": 80
}
```

`acceptTab` defaults to `false`. When `true`, Tab accepts the visible suggestion into an empty editor without submitting; this can steal Tab from autocomplete while a suggestion is visible.

`display` can be `ghost` or `belowEditor`; default is `ghost`.

The extension currently installs its editor component in both enabled display modes to implement acceptance keys. Either mode can override another custom editor; `belowEditor` changes presentation, not editor ownership. Disabled startup leaves the existing editor untouched. Disabling after startup does not restore an earlier editor. Pi exposes no compare-and-restore editor API; editor-composable below-editor acceptance remains unresolved.

`model` uses `provider/modelId` and overrides the default Terra model. If a configured model is malformed or not found, the extension falls back to the active Pi model. Authentication or generation failures do not trigger fallback.

For an installed version that still defaults to the legacy provider, set `"model": "openai/gpt-5.6-terra"` in the global config above, preserving any other settings. A project model override takes precedence.

The suggestion-generation system prompt lives in [`prompts/suggestion-system-prompt.md`](prompts/suggestion-system-prompt.md). Edit that file if you want to change the generation instructions before packaging/installing from source.

See [`docs/plan.md`](docs/plan.md) for the implementation plan.

## Development

Run the validation suite:

```bash
npm run validate
```

Try the extension interactively from the local test project:

```bash
cd test
pi
```
