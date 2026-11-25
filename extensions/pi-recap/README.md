# pi-recap

A [Pi Coding Agent](https://pi.dev) extension for a pinned, personal return note and on-demand conversation recaps. Neither becomes an agent message.

## Install

```sh
pi install https://github.com/SteelDynamite/pi-recap.git
```

## Return note (interactive Pi terminal)

When a submitted prompt reaches the agent, a compact chooser above the editor offers your last note, a suggested replacement, and a blank note. Use ↑/↓ and Enter to open a choice for editing; Enter again pins the single line and returns to your ordinary prompt. Pasted line breaks become spaces. Esc at either step discards the draft, not the previous note. A blank submission clears the pin. Use `/note` to edit directly, or click the pinned note in a fullscreen terminal with mouse support. Regular terminal mode leaves clicks to the terminal.

The agent continues while you edit. A suggestion arriving late never selects itself or alters a draft. The note stays with its conversation branch across restart, reload, and tree navigation; only submitted notes are persisted. Notes are stored locally in the Pi session file, not secret storage. There is no agent note tool. Selecting or saving a note does not send it to a model.

For the suggestion, the extension makes at most one auxiliary request per chooser to the current model, which may incur provider charges. It asks for one short sentence about the high-level state of the work, using bounded user/assistant conversation text and the current request, **not** your saved note, unsaved draft, tool output, or raw system prompt. The last note and blank option do not depend on the request succeeding. Offline mode, a missing model, or missing auth leaves them available without a request. Tool iterations and automated continuations do not reopen the chooser. A blocking Pi question takes priority over the note.

A nonblank `OMB_MCP_CONFIG` disables the note feature at extension initialization, including `/note`, the widget and all suggestion work. Non-terminal and orchestrated-child runs do not open a note UI or request suggestions.

## Manual recaps

- Run `/recap` to generate a recap on demand. There are no automatic recaps on idle, settle, resume, or model change. Old recap entries remain readable.
- Uses the active model through Pi 1.4's provider-neutral `streamSimple()` facade, including virtual-model routing and request-time authentication.
- Builds the prompt from Pi's canonical effective context: context edits, removals, and compaction apply. No raw-history fallback restores removed content.
- Sends only user text and normally completed assistant text, without tools, project system prompts, raw tool output, or intermediate/interrupted assistant output. Compaction and branch summaries are not included.
- Bounds input to eight recent answered exchanges, a pending request, and 32 KiB.
- Produces one plain-text recap, including a next step when relevant.
- Rejects results if the active session branch changes while generation runs.
- Rejects failed, aborted, truncated, or late responses, even when their text looks valid. Only successful recaps advance progress.
- Cancels generation on input, agent start, model change, or shutdown. Each attempt has a 60-second deadline, including when a provider ignores cancellation; late results are discarded.
- Warns on failure without retrying.

Recaps are custom session entries rendered in a theme-aware block. They remain visible at their transcript position after scrolling, reload, or resume, but Pi excludes them from agent context. Expanded entries show trigger, model, and reported request cost. Recap usage is not included in Pi's session totals.

## Development

```sh
npm install
test_home=$(mktemp -d)
trap 'rm -rf "$test_home"' EXIT
HOME="$test_home" PI_CODING_AGENT_DIR="$test_home/agent" PI_OFFLINE=1 PI_ORCHESTRATED_CHILD=0 npm run validate
```

Tests include the repository's Pi 1.4 host loader, canonical session context, and deterministic local physical/virtual providers. They do not contact live providers or use active configuration. The standalone development lock predates Pi 1.4; the narrow `streamSimple()` type adapter is also checked against the current host during maintenance.

## License

[MIT](LICENSE)
