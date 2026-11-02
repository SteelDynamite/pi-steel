# pi-read-before-write

Pi package that blocks stale `edit` and destructive existing-file `write` operations when files changed since the agent last read them.

> Disclaimer: this is clanker slop. Use at your own risk.

## Why

This adds Claude Code-style stale-file protection to Pi without patching Pi core. It reduces accidental clobbers when a file is edited externally, by another agent, or by a parallel workflow after the current agent last read it.

## Install

From npm:

```bash
pi install npm:pi-read-before-write
```

From GitHub:

```bash
pi install git:github.com/SteelDynamite/pi-read-before-write
```

For project-local install:

```bash
pi install -l npm:pi-read-before-write
```

For local development/testing:

```bash
npm install
npm run build
pi -e ./dist/index.js
```

## Behavior

- Successful `read` calls record a SHA-256 fingerprint of the exact full-file buffer consumed by Pi. Partial, truncated, and image reads retain Pi's output semantics; they authorize the full source file, not just visible lines/pixels.
- `edit` is blocked unless the file was read in the current Pi session and is unchanged.
- `write` to an existing file is blocked unless the file was read in the current Pi session and is unchanged.
- `write` to a new file is allowed.
- If a previously read file is deleted before `edit` or `write`, the operation is blocked.
- Successful `edit`/`write` calls authorize the bytes Pi supplied to the filesystem, never a later independent disk snapshot. An edit also checks that its source bytes remain current, even if a concurrent read authorized another version.
- Failed/aborted mutations revoke authorization before filesystem I/O while retaining deletion history. Failed reads do not erase prior history.
- A bounded LRU holds at most 100 file records, 100 aliases, and 1 MiB of estimated string metadata, including unauthorized/deletion records. Any limit evicts entire records and their aliases.
- State is isolated per extension instance and cleared on `session_start`, `session_tree`, `session_compact`, and `session_shutdown`. Re-read after navigation, compaction, reload, or session replacement. In-flight operations cannot populate replacement state.
- Filesystem inspection errors fail the tool instead of treating an unread existing file as new.
- Pi resolves tool paths itself, including Unicode spaces, leading `@`, `~`, file URLs, Windows shell-drive paths, and read-only filename fallbacks. The guard receives that actual resolved path; writes do not inherit read-only filename fallback behavior.
- Symlink aliases share canonical identity. Missing paths resolve through existing parent directories and dangling links, preserving retained deletion history through previously unseen aliases.

## Block messages

Unread file:

```text
Blocked stale write: file has not been read in this session. Read it before editing: path/to/file.ts
```

Changed file:

```text
Blocked stale write: file changed on disk since the last read. Read it again before editing: path/to/file.ts
```

Deleted file:

```text
Blocked stale write: file was deleted since the last read: path/to/file.ts
```

## Limitations

1. This is an accidental-clobber guard, not an adversarial filesystem sandbox. It does not protect `bash`, external scripts, other processes, or custom/remote tools. Another extension replacing `read`, `edit`, or `write` can supersede these wrappers; do not combine competing replacements.
2. Filesystem path resolution, hashing, and writes are not atomic. Changes or symlink swaps between inspection and I/O, including an ABA swap, remain possible. Capturing operation buffers closes independent post-result certification races; it does not prove which inode supplied/received bytes during every concurrent filesystem change.
3. A successful full-file operation establishes a version, not proof that the model saw every byte. Partial/truncated reads, image processing, and other extensions' result transformations may hide content. This preserves the existing whole-file authorization policy.
4. State is process-local, nonpersistent, and bounded. Eviction/reset loses deletion history; an evicted missing path is treated as new. Existing evicted files require rereading. Metadata accounting estimates strings, not total JavaScript heap usage; active calls also hold local state.
5. Large files are read and hashed in full without a per-file byte cap. Concurrent operations can fail conservatively and require rereading.
6. The wrappers reuse Pi 1.4's exported tool definitions, schemas, rendering, edit algorithm, image processing, and mutation queues. Host updates require revalidation. Native Windows/macOS behavior and interactive rendering have not been tested here. Custom host read options are not inherited; definition defaults and per-call model image limits apply.

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:pack
npm run audit:release
npm run build
```

Run from this module after the collection's root dependencies and this module's development dependencies are installed. Pi 1.4 supplies `@earendil-works/pi-coding-agent` at runtime; it is external, not bundled. No additional runtime package is installed by this module.

`npm test` compiles `src/index.ts`, exercises actual exported host tools, and launches a fresh Pi CLI with a deterministic local provider, denied network access, and temporary HOME/PI_CODING_AGENT_DIR. Regressions cover read/mutation replacement races, edit source freshness, own-mutation chaining, partial/image reads, filename fallbacks, aliases/deletion, failures/abort, lifecycle invalidation, and bounded metadata. `test:pack` imports and invokes every declared extension entry with the host external supplied explicitly.

The unshipped `docs/PLAN.md` is historical design material, not a current ordering or test-coverage contract.

## License

MIT
