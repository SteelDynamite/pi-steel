# pi-answer

Pi extension for answering questions from the last assistant response in terminal Pi or RPC clients such as Paseo.

Adapted from [`mitsuhiko/agent-stuff/extensions/answer.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/answer.ts).

## Install

```bash
pi install git:github.com/SteelDynamite/pi-answer
```

For local testing:

```bash
pi -e ./index.ts
```

## Usage

Run:

```text
/answer
```

Or press `Ctrl+.`.

The extension:

1. Finds the last completed assistant message.
2. Uses `openai/gpt-6.1-sol` to extract questions and optional recommended answers as JSON.
3. Opens an answer-entry flow.
4. Sends your compiled answers back into the session.

In terminal Pi, `/answer` opens the rich interactive Q&A UI. It ghost-fills recommended answers when available; press Right Arrow to accept one. `Ctrl+.` is a terminal shortcut for `/answer`.

Extracted text is treated as plain text: terminal control sequences are removed. Progress and questionnaire lines fit the available width; narrow questionnaires drop their frame to preserve editing space. Below three columns, only the cursor is shown because the host editor cannot lay out wide characters there; resize to see the answer. Multiline recommendations have a single-line ghost preview; accepting one preserves its line breaks.

In RPC clients such as Paseo, `/answer` falls back to simple dialog cards. Extraction runs without the custom progress UI, then each question appears as a sequential editor/text card. Recommended answers are prefilled when supported. Cancelling a card, or submitting an empty answer, stops without sending compiled answers.

Cancellation discards partial answers. When Pi supplies an active operation signal, its abort invalidates extraction and pending answers; session shutdown does the same. Pi 1.4 does not expose an idle RPC command-abort signal, so use the card's cancel action when no agent run is active. Already-open RPC cards may remain visible after invalidation, but late responses are ignored.

Extraction always uses `openai/gpt-6.1-sol`, independent of the session model. Use a Pi host with the unified `openai` provider and configure its authentication through `/login openai` (ChatGPT subscription or API key), or `OPENAI_API_KEY`. The model must be registered under `openai`; if unavailable, `/answer` reports an error without selecting another provider or model.

On current Pi, extraction uses the host's provider-neutral `streamSimple` route with request-time authentication. Older hosts use resolved authentication, endpoint, headers, and environment through their legacy completion adapter.

Provider IDs and transport APIs are distinct: the extension preserves the registered model's transport, including `openai-codex-responses` when configured. That transport name is not a provider ID.

## Development

```bash
npm ci
npm run validate
```

Validation runs typechecking, offline regression tests, and a package dry run. Run tests alone with `npm test`.

Probe an installed Pi 1.4 host's actual extension loader, virtual routing, and resolved authentication without network requests:

```bash
test_home=$(mktemp -d)
HOME="$test_home" PI_CODING_AGENT_DIR="$test_home/agent" \
  node tests/host-probe.mjs /path/to/pi-coding-agent
rm -rf "$test_home"
```

The component tests check geometry, resize, focus markers, animation, and stale-result suppression. They do not verify physical IME candidate positioning or regular/fullscreen terminal integration.

## License

Apache-2.0
