# pi-transcript

A focused transcript and context-rewrite viewer for [Pi Coding Agent](https://pi.dev).

`/transcript` groups the active session into user-prompt and assistant-response blocks. Tool calls, tool results, thinking, notices, summaries, and session metadata stay out of this focused view.

## Install

```sh
pi install https://github.com/SteelDynamite/pi-transcript.git
```

## Usage

```text
/transcript
```

Each block defaults to **keep**:

- `Up`/`Down`: select a block
- `k`: keep or restore the original block
- `c`: compact the complete block
- `d`: drop the block from model context
- `Enter`: toggle a compacted block between its summary and original text
- `Page Up`/`Page Down`: scroll one line
- `Home`/`End`: select the first/last block
- `Esc` or `q`: close

Closing a modified view offers **Apply rewrite**, **Discard changes**, or **Return to viewer**.

## Context rewriting

Applying changes creates a replacement session without triggering an agent turn. The previous session remains linked as its parent.

- **Keep** copies the effective block, including hidden tool activity, honoring Pi's context edits and redactions.
- **Compact** asks the current model to summarize all selected blocks in one request, then stores each summary as visible model context. Summaries appear in Pi's normal transcript and HTML exports.
- **Drop** excludes the block from model context.
- Blocks wholly or partly removed from effective context remain `PI-COMPACTED · READ ONLY`; their removed originals are not displayed or restored.
- Canonical summaries, retained tails, and interleaved messages keep their order across repeated rewrites. Prior `system-reminder` messages are omitted because session startup regenerates them.

Extension-compacted and dropped blocks remain visible on later `/transcript` calls. `k` explicitly restores their source content; `c` can compact a dropped block. Source lookup honors the source session's effective context rather than bypassing its redactions or compaction. Originals are referenced in parent session files rather than duplicated, so restoration becomes unavailable if an original session file is deleted or its content is no longer available in effective context.

RPC clients receive an editor preview followed by simple action selectors. Context rewriting requires a persisted session. Context-edit projection and provider-neutral summarization require Pi 1.4 or newer; older hosts without context edits can still view, keep, and drop blocks.

Reviews are rejected if the session, leaf, idle state, or queued messages change before replacement. This is a pre-call guard, not a transaction across other extensions' asynchronous session-switch hooks. Summary requests have a 60-second deadline and cancel on new input, agent startup, or session shutdown. Failed, aborted, truncated, and late results never rewrite context.

## Development

```sh
npm install
test_home=$(mktemp -d)
HOME="$test_home" PI_CODING_AGENT_DIR="$test_home/agent" npm run validate
rm -rf "$test_home"
```

## License

[MIT](LICENSE)
