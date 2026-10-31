# pi-token-speed

A minimal [Pi Coding Agent](https://pi.dev) extension that shows dim token speed in the footer:

```text
25.0 tok/s
```

## Install

```sh
pi install https://github.com/SteelDynamite/pi-token-speed.git
```

## Behavior

- Publishes footer status key `tokenSpeed`.
- Shows a live five-second rolling estimate after a 500 ms warm-up.
- Estimates streamed text, thinking, and tool-call deltas as four characters per token.
- Omits the first emitted chunk from the live estimate to avoid first-token bias.
- At each model-call end, uses reported output tokens minus the first output token when available; otherwise uses estimated characters after the first chunk.
- Shows the duration-weighted aggregate for all measurable model calls in the current agent run. Timing runs from the first emitted delta to the last, excluding TTFT, tool execution, and completion-tail latency.
- Keeps the final aggregate until the next agent run.

No settings, commands, dialogs, networking, subprocesses, or timers.

## Development

```sh
npm install
npm test
npm run typecheck
npm pack --dry-run
```

## License

[MIT](LICENSE)
