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

- **Keep** copies the complete block, including hidden tool activity.
- **Compact** asks the current model to summarize all selected blocks in one request, then stores each summary as visible model context. Summaries appear in Pi's normal transcript and HTML exports.
- **Drop** excludes the block from model context.
- Blocks already removed by Pi's own compaction remain visible as `PI-COMPACTED · READ ONLY`.

Compacted and dropped blocks remain visible on later `/transcript` calls. `k` restores their original content; `c` can compact a dropped block. Originals are referenced in parent session files rather than duplicated, so restoration becomes unavailable if an original session file is deleted.

RPC clients receive an editor preview followed by simple action selectors. Context rewriting requires a persisted session.

## Development

```sh
npm install
npm run validate
```

## License

[MIT](LICENSE)
