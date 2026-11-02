# pi-recap

A [Pi Coding Agent](https://pi.dev) extension that adds persistent, Codex-style conversation recaps without adding them to model context.

## Install

```sh
pi install https://github.com/SteelDynamite/pi-recap.git
```

## Behavior

- Run `/recap` to generate a recap on demand.
- In TUI sessions, generates one automatically after 30 settled minutes.
- Requires three completed exchanges and two new exchanges after the previous recap. Progress counts branch history across compaction; only assistant responses ending normally count.
- On resume, counts idle time from the latest normally completed assistant response.
- Uses the active model through Pi 1.4's provider-neutral `streamSimple()` facade, including virtual-model routing and request-time authentication.
- Builds the prompt from Pi's canonical effective context: context edits, removals, and compaction apply. No raw-history fallback restores removed content.
- Sends only user text and normally completed assistant text, without tools, project system prompts, raw tool output, or intermediate/interrupted assistant output. Compaction and branch summaries are not included.
- Bounds input to eight recent answered exchanges, a pending request, and 32 KiB.
- Produces one plain-text recap, including a next step when relevant.
- Rejects results if the active session branch changes while generation runs.
- Rejects failed, aborted, truncated, or late responses, even when their text looks valid. Only successful recaps advance progress.
- Cancels generation on input, agent start, model change, or shutdown. Each attempt has a 60-second deadline, including when a provider ignores cancellation; late results are discarded.
- Retries one automatic failure, including a deadline, after 30 seconds. Manual failures warn without retrying.
- Suppresses automatic recaps in orchestrated child sessions and non-TUI modes.

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
