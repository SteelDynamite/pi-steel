# pi-recap

A [Pi Coding Agent](https://pi.dev) extension that adds persistent, Codex-style conversation recaps without adding them to model context.

## Install

```sh
pi install https://github.com/SteelDynamite/pi-recap.git
```

## Behavior

- Run `/recap` to generate a recap on demand.
- In TUI sessions, generates one automatically after 30 settled minutes.
- Requires three completed exchanges and two new exchanges after the previous recap.
- On resume, counts idle time from the latest assistant response.
- Uses the active model in an isolated request with no tools, project system prompt, or raw tool output.
- Bounds input to eight recent answered exchanges, a pending request, and 32 KiB.
- Produces one plain-text recap, including a next step when relevant.
- Rejects results if the active session branch changes while generation runs.
- Retries one automatic failure after 30 seconds.
- Suppresses automatic recaps in orchestrated child sessions and non-TUI modes.

Recaps are custom session entries rendered in a theme-aware block. They remain visible at their transcript position after scrolling, reload, or resume, but Pi excludes them from agent context. Expanded entries show trigger, model, and reported request cost. Recap usage is not included in Pi's session totals.

## Development

```sh
npm install
npm run validate
```

## License

[MIT](LICENSE)
