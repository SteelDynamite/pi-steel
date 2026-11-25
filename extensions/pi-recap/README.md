# pi-recap

A [Pi Coding Agent](https://pi.dev) extension for a pinned, personal return note and on-demand conversation recaps. Neither becomes an agent message.

## Install

```sh
pi install https://github.com/SteelDynamite/pi-recap.git
```

## Return note (interactive Pi terminal)

The note stays below the todo list and above the prompt. Its text uses the terminal’s bright blue on the normal terminal background, independent of the prompt outline. Saved text wraps to the terminal width; only an empty note shows the shortcut hint. Press **Alt+N** to edit the saved note without losing an unfinished prompt. You can also use `/note` or click the line in fullscreen mode. Starting or finishing a run never focuses the note; the agent can finish while you edit.

While editing, **Ctrl+C** clears the draft and keeps focus in the note. **Enter** saves and returns to the prompt; saving an empty draft clears the pinned note. **Esc** discards the edit, including a Ctrl+C clear. Pasted line breaks become spaces. Outside the note, Ctrl+C keeps its normal Pi behavior. A blocking question takes priority; if Pi moves focus elsewhere, the note stops editing without saving or taking focus back.

Only saved notes persist, on the current conversation branch across restart, reload, and tree navigation. They are stored locally in the Pi session file, not secret storage. The note works offline: it makes no model request, is not sent to the agent, and has no agent tool.

A nonblank `OMB_MCP_CONFIG` disables the note feature at extension initialization, including `/note` and the widget. Non-terminal and orchestrated-child runs do not open a note UI.

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
