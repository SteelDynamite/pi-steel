# Pi Next-Prompt Suggestions Extension Plan

## Goal

Add Claude Code-like suggested next prompts to pi as an extension, without changing pi core.

The extension will:

- Generate a short suggested next user prompt after an agent loop finishes.
- Display the suggestion as inline ghost text by default, with a below-editor fallback mode.
- Accept the suggestion with Right Arrow when the input editor is empty.
- Submit the suggestion with Enter when the input editor is empty.
- Optionally accept the suggestion with Tab when enabled.
- Avoid interfering with existing Tab/autocomplete behavior by default.

## UX

When pi finishes responding, show a dim ghost hint in the editor:

```text
run the tests
```

Fallback `belowEditor` mode shows:

```text
→ run the tests
```

Behavior:

- Press `Right Arrow` on an empty input to fill the editor with the suggestion without submitting.
- Press `Enter` on an empty input to submit the suggestion immediately.
- If `acceptTab` is enabled, press `Tab` on an empty input to fill the editor without submitting.
- Start typing anything else to clear the suggestion.
- Submit normally with Enter after accepting/editing.
- No suggestion is shown if the next step is not obvious.

## Architecture

### Extension responsibilities

1. Subscribe to `agent_end`.
2. Generate a suggestion asynchronously.
3. Render the suggestion as editor ghost text, or using `ctx.ui.setWidget()` in fallback mode.
4. Replace the editor with a small `CustomEditor` subclass via `ctx.ui.setEditorComponent()`.
5. Accept the suggestion on Right Arrow only when the editor is empty.
6. Submit the suggestion on Enter only when the editor is empty.
7. Optionally accept the suggestion on Tab only when the editor is empty and `acceptTab` is enabled.
8. Clear stale suggestions on user input, new agent turns, session changes, and reload/shutdown.

### Pi core responsibilities

No required core changes.

Optional future core improvement:

- Add native editor suggestion primitives:
  - `ctx.ui.setEditorSuggestion(text | undefined)`
  - render inline ghost text
  - accept with Tab/Right Arrow

## Files

Current package layout:

```text
src/index.ts                         # extension implementation
prompts/suggestion-system-prompt.md  # model instruction prompt
README.md                            # user docs
docs/plan.md                         # implementation notes
tests/*.test.ts                      # automated helper tests
test/.pi/extensions/*.ts             # local interactive test harness
```

Installed package entrypoint is declared in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Implementation Steps

### 1. Create extension state

Maintain module-level/session-level state:

```ts
let suggestion: string | undefined;
let generationId = 0;
let lastCtx: ExtensionContext | undefined;
```

State rules:

- `suggestion` holds the currently visible suggestion.
- `generationId` invalidates stale async model responses.
- `lastCtx` lets the custom editor accept/clear via current UI context.

### 2. Render suggestion

Default `ghost` mode renders inside the custom editor by modifying the editor render output. This is intentionally hacky and may need adjustment if Pi editor rendering changes.

Fallback `belowEditor` mode uses a widget below the editor:

```ts
ctx.ui.setWidget(
  "next-prompt-suggestion",
  suggestion
    ? (_tui, theme) => ({
        render: () => [theme.fg("dim", `→ ${suggestion}`)],
        invalidate: () => {},
      })
    : undefined,
  { placement: "belowEditor" }
);
```

Clear with:

```ts
ctx.ui.setWidget("next-prompt-suggestion", undefined);
```

### 3. Add custom editor wrapper

Subclass pi's `CustomEditor`:

```ts
class SuggestionEditor extends CustomEditor {
  handleInput(data: string): void {
    if (this.getText().length === 0 && suggestion) {
      if (isRightArrow(data)) {
        this.setText(suggestion);
        clearSuggestion();
        return;
      }

      if (isEnter(data)) {
        this.setText(suggestion);
        clearSuggestion();
        super.handleInput(data);
        return;
      }
    }

    if (suggestion && isUserEditKey(data)) {
      clearSuggestion();
    }

    super.handleInput(data);
  }
}
```

Important constraints:

- Do not use `registerShortcut("right")`; it would consume Right Arrow globally and break cursor movement.
- Only intercept Right Arrow/Enter when the editor is empty and a suggestion exists.
- Right Arrow fills the editor without submitting.
- Enter fills the editor and passes through to normal submit handling.
- Otherwise pass through to `super.handleInput(data)`.

### 4. Install editor on `session_start`

```ts
pi.on("session_start", (_event, ctx) => {
  lastCtx = ctx;
  ctx.ui.setEditorComponent((tui, theme, keybindings) =>
    new SuggestionEditor(tui, theme, keybindings)
  );
});
```

### 5. Generate suggestions on `agent_end`

On `agent_end`:

1. Clear existing suggestion.
2. Skip if no UI.
3. Skip if there are queued messages.
4. Skip if editor is non-empty.
5. Start async generation.
6. Ignore stale response if `generationId` changed.
7. Validate/sanitize output.
8. Render widget.

Pseudo-code:

```ts
pi.on("agent_end", async (event, ctx) => {
  clearSuggestion();

  if (!ctx.hasUI) return;
  if (ctx.hasPendingMessages()) return;
  if (ctx.ui.getEditorText().trim()) return;
  if (!ctx.model) return;

  const id = ++generationId;
  const text = await generateSuggestion(event.messages, ctx);
  if (id !== generationId) return;

  const clean = sanitizeSuggestion(text);
  if (!clean) return;

  suggestion = clean;
  renderSuggestion(ctx);
});
```

### 6. Suggestion prompt

Use the strict prompt in `prompts/suggestion-system-prompt.md`, modeled after Claude Code's observed behavior:

```text
[SUGGESTION MODE: Suggest what the user might naturally type next into pi.]

First, look at the user's recent messages, original request, and the assistant's latest response.
Predict what the user would naturally type next, not what you think they should do.

The test: would the user think "I was just about to type that"?

Good suggestions:
- are 2-12 words
- match the user's style
- are specific
- continue an obvious workflow

Examples:
- User asked to fix a bug and tests were not run: run the tests
- Code was written and obvious manual check remains: try it out
- Assistant asks whether to continue: yes
- Task complete and changes are ready: commit this

Never suggest:
- thanks / looks good / evaluative replies
- questions
- Claude/pi voice like "let me" or "I'll"
- new ideas the user did not ask about
- multiple sentences
- unsafe or sensitive actions, including security incidents, credentials, harm, or private data

If the user explicitly said what they will ask next, suggest that exact next request.
If a file was created/edited and tests/checks were not run, the next step is clear: suggest running the relevant test/check.
Only reply with nothing when there is genuinely no plausible next user prompt.
Reply with only the suggestion text.
```

### 7. Model call

Use `completeSimple()` from `@earendil-works/pi-ai`.

Inputs:

- Current model: `ctx.model`
- API key/headers from `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)`
- Short context derived from recent `event.messages`
- Small bounded max token limit; current implementation uses 256 so reasoning models have room to emit visible text
- Do not pass `temperature`; some Pi providers/models reject it

Model selection:

- Use the active Pi model by default.
- Optionally use config `model` as `provider/modelId` for a cheaper/faster suggestion model.
- If the configured model is missing or invalid, fall back to the active Pi model.

### 8. Sanitize output

Reject suggestions that are likely bad:

- empty
- more than `maxChars` characters, default 80
- more than 12 words
- fewer than 2 words unless the single word is an allowed command/confirmation like `yes`, `continue`, `commit`, or `/help`
- more than one sentence
- contains newline
- contains markdown formatting such as bullets or `**`
- starts with labels like `Suggestion:` or `User:`
- wraps meta text like `[no suggestion]` or `(silence)`
- is model meta-output like `no suggestion`, `nothing to suggest`, `silence`, or `stay silent`
- is provider/error text like `api error:`, `prompt is too long`, `request timed out`, or `invalid api key`
- starts with assistant voice:
  - `let me`
  - `I'll`
  - `I can`
  - `Here's`
- ends with `?`
- is gratitude/evaluation:
  - `thanks`
  - `thank you`
  - `looks good`
  - `great`
  - `perfect`

Normalize:

- trim whitespace
- strip wrapping quotes
- strip trailing period if otherwise valid

### 9. Clear suggestion events

Clear suggestion on:

- `agent_start`
- `input`
- `session_shutdown`
- `session_start`
- user typing/editing in the custom editor
- accepting the suggestion
- `/reload` indirectly through session lifecycle

### 10. Error handling

If suggestion generation fails:

- Do not show an error by default.
- Optionally log/debug only.
- Never block agent completion or user input.

### 11. Configuration

Supported options:

```ts
const config = {
  enabled: true,
  acceptTab: false,
  display: "ghost",
  maxChars: 80,
  maxTokens: 256,
  model: undefined,
};
```

The current implementation loads extension-specific config from:

```text
~/.pi/agent/extensions/prompt-suggestions.json
.pi/prompt-suggestions.json
```

Project config overrides global config:

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

Possible future additions:

- extension flags for one-off overrides
- `/next-suggestion on|off`

## Risks

1. **Right Arrow detection**
   - Use pi-tui `matchesKey(data, "right")` rather than raw escape sequences.

2. **Editor compatibility**
   - Extend `CustomEditor`, not base `Editor`, so app-level keybindings still work.

3. **Stale async result**
   - Use `generationId` and clear on new input/agent start.

4. **Suggestion quality**
   - Prompt must strongly prefer silence over weak suggestions.
   - Sanitizer should reject questionable output.

5. **Latency/cost**
   - Run after agent end, asynchronously.
   - Use low max tokens.
   - Consider cheaper model later.

## Acceptance Criteria

- After a successful obvious task, a short suggestion appears as ghost text, or below the editor when `display` is `belowEditor`.
- Pressing Right Arrow on an empty editor fills the suggestion.
- Pressing Enter on an empty editor submits the suggestion.
- Pressing Right Arrow or Enter with non-empty editor behaves normally.
- Typing clears the suggestion.
- Tab/autocomplete behavior is unchanged unless `acceptTab` is enabled.
- No suggestion appears for unclear next steps.
- Suggestion generation failure is silent and non-blocking.

## Future Improvements

1. Native inline ghost text if pi core adds editor suggestion primitives.
2. User command to enable/disable suggestions.
3. Heuristic suggestions without model call for common cases:
   - tests not run
   - git changes present
   - assistant asked yes/no
4. Per-project style learning from prompt history.
