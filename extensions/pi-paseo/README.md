# pi-paseo

Automatic [Paseo](https://paseo.sh) terminal activity and optional Paseo control tools. Included in Steel's `Everything` loadout; independently selectable as `pi-paseo`. Install the Steel package, not a second standalone copy.

## Activity

In a Paseo **terminal**, Pi reports running, idle, and waiting for an extension dialog. Paseo owns the tab/workspace indicators and notifications. In Paseo's **native chat interface**, its Pi adapter already reports activity; this extension does not duplicate it.

Detection uses Paseo's injected `PASEO_TERMINAL_ID`, `PASEO_ACTIVITY_TOKEN`, and `PASEO_TERMINAL_ACTIVITY_URL`. Reporting requires Pi TUI mode and an HTTP endpoint at `/api/terminal-activity` on literal `127.0.0.1` or `::1`. No DNS, proxy, redirects, fallback port, credential search, or transcript upload. Outside Paseo, and in `PI_ORCHESTRATED_CHILD=1` children, activity is inactive.

- Reports running at agent start; reports idle at `agent_settled`, not `agent_end`, so queued work and automatic retries do not announce premature completion.
- Reports `needs-input` around Pi extension dialogs, including custom TUI dialogs. Closing the dialog restores the current agent state. This does not detect arbitrary subprocess prompts or all built-in Pi screens.
- Startup clears stale activity. Reload, session replacement, and graceful exit send a final idle reset. Hard kills cannot run cleanup.
- Requests have a 750 ms deadline. One request and one latest pending state bound activity work; rapid intermediate transitions may be coalesced. Startup waits for its reset; graceful shutdown drains at most the in-flight request and final reset. Ordinary turns and dialogs do not wait for networking. No automatic retries or polling.
- Failures do not interrupt Pi; `/paseo status` shows the latest activity error without exposing the token. No persistent footer, widget, or extra model turn.

Paseo's protocol cannot distinguish cancellation, failure, or graceful shutdown from successful completion: all use `idle`. Paseo also clears activity on terminal interrupt input. Its notification preferences and focus policy still apply. Activity support does **not** create a native agent timeline, synchronize session titles, or expose Steel subagents/tasks in Paseo's native UI.

## Local activity diagnostics

Diagnostics default **on** for Paseo TUI sessions, independently of control tools. They observe reporting; they do **not** fix or explain an absent Paseo indicator. A parent awaiting a foreground subagent can be working while Paseo returns `activity: null`; the cause is unknown. Do not infer Escape, Ctrl+C, or successful delivery from that observation alone.

`/paseo status` shows the file, terminal hash, runtime ID, and process-wide acknowledged-write, dropped-event, and pending counters. A safe failure classification remains visible after activity HTTP requests recover. No footer, notification loop, model turn, or upload is added. Invalid injected TUI connections record their startup eligibility reason. Outside Paseo, in RPC/native sessions, and in orchestrated children, no diagnostic file is opened; nonchild status explains ineligibility.

### Storage and loss policy

- **One file per OS user home:** `~/.pi-paseo-diagnostics/activity.v1.log` (Windows: the user profile's `.pi-paseo-diagnostics` directory). All projects, agent directories, runtime reloads, and concurrent Pi processes sharing that home share the same **4,194,304-byte log-data ceiling**: 4,096 slots × 1,024 bytes. No rotations, temporary files, lock files, per-session files, or index. Filesystem allocation/metadata, journals, backups, and user-made copies are outside this log-data bound.
- Each process starts at a random slot and overwrites sequentially, wrapping in place. Concurrent writers may overwrite or tear each other's records; SHA-256 checksums let the reader reject torn records. There is no global chronological ordering or guaranteed last-N retention across processes. Without new events, records remain indefinitely; busy sessions can displace another session's evidence immediately. This is bounded diagnostic sampling, not an audit journal.
- One detached **local writer subprocess per Pi process**, shared across runtime reloads, performs synchronous filesystem calls away from Pi's main thread and shared async filesystem pool. At most **64 queued 1-KiB records plus one in flight**, with admission capped at **32 records/second plus a 64-record burst** per Pi process. At the queue/rate limit, new events are dropped rather than extending the backlog. The writer receives only one record at a time over unreferenced IPC; standard I/O is ignored and the parent environment is not inherited. Its V8 limits are 16 MiB old generation, 2 MiB per semi-space (up to 6 MiB young generation), and 1 MiB stack—not a total process RSS guarantee.
- One unreferenced **1-second deadline** exists only while a write acknowledgment is pending. Filesystem/writer failure, a short write, or timeout drops outstanding work and permanently disables that Pi process's writer. Failure/disposal disconnects IPC and requests one forced termination; normal Pi exit does the same. No retries, lock waits, replacement writers, polling, or idle timers. Reload retains the writer, failure, and counters. Counters saturate at `Number.MAX_SAFE_INTEGER`.
- Shutdown closes runtime logging without waiting for disk. The process-owned writer may finish already queued records until Pi exits, but abrupt exit, timeout, OS cache loss, or concurrent overwrite can lose them. `written` means writer acknowledgment, **not fsync durability**. Dropped counters cover local rejection/failure, not overwrites, crashes, or other processes; sequence gaps are not proof of any one cause. No background cleanup can grow a backlog.
- New POSIX directories/files use `0700`/`0600`; nonprivate or foreign-owned storage, symlinks, nonregular files, hard-linked files, and oversized files are rejected, not repaired or deleted. Windows relies on inherited private user-profile ACLs; Node modes do not establish Windows ACLs. Use a private local home, not a shared/public profile or network-mounted home. Administrators and the same OS account can still access diagnostics. Malformed slot contents need no recovery state and are overwritten normally. Do not externally rotate or replace the file while writers are active.

A separate process is intentional: Node can wait indefinitely for a worker thread blocked inside an OS filesystem call, even after `terminate()`/`unref()`. The detached writer and its IPC cannot hold Pi's event loop open. An OS-uninterruptible operation may still delay the writer's termination until the kernel returns; there is no portable absolute cancellation guarantee. It is never replaced in that Pi process. Repeatedly launching new Pi processes against a broken filesystem can leave additional OS-stuck helpers; stop doing so and resolve the filesystem problem. The shared log-data bound still holds.

Writer launch requires a recognized plain Node executable named `node` or `node.exe`, Node runtime metadata, and a negative Node SEA check. Electron, Bun, Node single-executable applications, known packaged runtimes, and renamed/unknown executables **fail closed** as `unsupported_runtime`. No executable probe, interpreter search, Pi CLI, provider, or model session is launched. Activity HTTP reporting still works when diagnostics are unsupported. This deliberately limits diagnostic support rather than assuming `process.execPath` always interprets JavaScript.

### Fields and interpretation

The runtime allowlist contains schema version, UTC timestamp, random process/runtime IDs, SHA-256 terminal correlation, runtime sequence, local dropped count, lifecycle source/reason, eligibility, computed state/idle/waiting facts, host-reported abort/error booleans, request IDs, replaced/in-flight request IDs, classified outcome, HTTP status, and monotonic duration. Terminal IDs are never filenames. **No** prompt, tool argument/result, transcript, UI title, repository/session path, credential, endpoint URL/query, raw error/stack, or response body is recorded.

`queued.request` links to `request_start` and `request_end` within one runtime; `replaced` identifies a pending request coalesced away, and `inFlight` identifies the request it waited behind. `request_end.outcome=ok` means HTTP 204—not proof that Paseo retained or displayed the state. `http`, `deadline`, `refused`, `reset`, `network`, and `setup` classify failures without error text. The activity transport still has its independent **750 ms** deadline and unchanged ordering/coalescing.

`subagent_start`/`subagent_end` use a hashed tool-call ID and parent idle/waiting facts. These are Pi tool lifecycle boundaries, including preflight/failed calls, not child turns or proof a child launched. They record no progress/token stream and add no activity requests. Children never take ownership of the parent indicator.

From the package checkout or installation directory, decode retained valid records in UTC order:

```sh
node extensions/pi-paseo/diagnostics-read.mjs
# Optional: inspect a manually copied snapshot, without modifying it.
node extensions/pi-paseo/diagnostics-read.mjs /path/to/activity.v1.log
```

The reader checks each fixed slot and checksum, reports invalid slots to stderr, and prints JSON events to stdout. A live read is not an atomic snapshot. Match the terminal hash from `/paseo status`, then group by runtime and sequence. Capture promptly after an incident; retained request/transition evidence can distinguish reporting attempts, coalescing, and endpoint failures, but cannot establish daemon-side clearing. There is no automatic export or upload.

## Settings

| Command | Effect |
| --- | --- |
| `/paseo` | Dialog with status and control-tool choices. |
| `/paseo status` | Show detection, activity health, diagnostic location/counters, and tool setting. |
| `/paseo tools on` | Save and enable this extension's control tool in the current session. |
| `/paseo tools off` | Save and hide this extension's tool; cancel its active CLI calls. |

Dialogs work in TUI and RPC clients. Configuration is global-only at `<agent-dir>/paseo.json` (normally `~/.pi/agent/paseo.json`):

```json
{ "tools": false }
```

Control tools default **off**, independently of automatic activity. Malformed configuration leaves tools off and is not silently overwritten. The command changes only this file, preserves unknown fields, and atomically replaces it. It never edits Pi's main settings or Paseo's configuration. Concurrent explicit writers are last-writer-wins; other running Pi sessions adopt changes on reload, not through polling. The command applies immediately to its own session.

The setting governs **only `paseo_control`**. Tools injected by Paseo or another extension remain untouched. Off means hidden and rejected at execution, not a security sandbox: Pi's ordinary shell can still run the Paseo CLI. Orchestrated children load neither the command nor the control tool.

## Control tool

When enabled and a Paseo terminal/agent marker is present, `paseo_control` executes the existing CLI without a shell. Requires Paseo on `PATH`, or Paseo's absolute `PASEO_HOOK_CLI` executable, and **exactly one** inherited `PASEO_HOME` or `PASEO_HOST`. Missing or ambiguous targets fail rather than guessing which daemon owns this session. Resolve launch-environment targeting before enabling tools; do not put passwords in prompts.

On Windows, an absolute `PASEO_HOOK_CLI` ending in `resources\bin\paseo.cmd` uses the bundled `Paseo.exe` directly with Paseo's Node entrypoint runner. The extension checks that the wrapper, executable, runner, and `app.asar` are files, then mirrors the wrapper's `ELECTRON_RUN_AS_NODE`, `PASEO_NODE_ENV`, `PASEO_DESKTOP_MANAGED`, and `PASEO_CLI` values. Inherited targeting, authentication, and caller identity remain intact. It never executes or parses batch commands and rejects other `.cmd`/`.bat` layouts. These are layout checks, not signature verification; the inherited installation must be trusted. A native executable remains supported. A batch-only Windows `PATH` installation needs the explicit bundled wrapper path; there is no shell fallback or installation search.

Paseo manages authentication using its normal environment and credential files. The extension never reads or copies those credentials. It does not install/start/restart a daemon or modify daemon settings. Paseo's CLI may create its own client identity during normal connection setup.

Each call requires `command` and exactly the fields listed below; omit irrelevant fields.

| `command` | Required fields | Effect |
| --- | --- | --- |
| `ls` | None | List nonarchived agents across workspaces. |
| `inspect` | `agentId` | Inspect an agent, including its status. |
| `run` | `workspaceId`, `provider`, `prompt` | Start an agent asynchronously in an existing workspace. |
| `send` | `agentId`, `prompt` | Steer an agent asynchronously, without interrupting its current turn. |
| `stop` | `agentId` | Cancel an agent's active run. |
| `workspace ls` | None | List workspaces. |
| `provider ls` | None | List providers. |
| `terminal ls` | None | List terminals across the host. |
| `terminal create` | `workspaceId`, `name` | Create a shell terminal in a workspace. |
| `terminal capture` | `terminalId` | Read terminal output. |
| `terminal send-keys` | `terminalId`, `keys`, `literal` | Send literal strings or interpreted key tokens such as `Enter`. |
| `terminal kill` | `terminalId` | Terminate a terminal. |

Use full IDs from list results: agents/terminals use UUIDs; workspaces accept `wks_` followed by 16 hexadecimal digits or absolute path-shaped IDs (POSIX, Windows drive paths, or UNC). Copy workspace IDs unchanged, including case and separators; do not substitute the workspace directory for a different returned ID. No fuzzy names, prefixes, bulk stop, arbitrary flags, or model-selected daemon target. Explicit workspace IDs avoid ambiguity when workspaces share a directory.

Calls have a 30-second deadline and 1 MiB capture cap **per stream**; displayed output is limited to 50 KiB/2000 lines. Discarded output is not saved. Truncated output can be incomplete JSON. Known environment secrets and credential-bearing URLs are redacted, but terminal output and agent details can contain other sensitive data; enabling control permits that data to enter Pi's conversation.

Launch failures report safe `code`, numeric `errno`, and syscall operation fields when available, including synchronous Windows spawn errors. Error messages, executable paths, and invocation arguments are omitted; normal CLI output still follows the redaction and truncation rules above.

Canceling a tool call, turning tools off, or exiting Pi kills the CLI request—not the daemon-owned work already submitted. Failed/timed-out mutations may have succeeded remotely: inspect before deciding what to do; never blindly retry. `run` and `send` receipts are not completion results. No background result watcher or automatic continuation is installed.

`run` passes `PI_ORCHESTRATED_CHILD=1` to prevent recursively exposing this integration or enabling Steel supervisors. Native sessions preserve Paseo's caller attribution; terminal-launched Pi has workspace context but is not itself a native Paseo agent. Child models, skills, extensions, and configuration come from the daemon's provider environment, not arbitrary parent Pi `-e` flags. This tool does not replace Steel's behavioral subagent contract.

## Integration boundaries

Source contract: [Paseo v0.15.3 activity](https://github.com/getpaseo/paseo/blob/v0.15.3/docs/terminal-activity.md) and [CLI](https://github.com/getpaseo/paseo/blob/v0.15.3/public-docs/cli.md). Requires Pi's `agent_settled` and `ui_prompt_start/end` events (Steel's Pi 1.4 test host supplies them).

Other supported surfaces remain available separately:

- [Native Pi provider](https://paseo.sh/docs/providers): structured chat, tool timeline, and RPC dialogs. Native recognition of Steel-specific task/subagent results requires Paseo-side adapter work.
- [MCP](https://paseo.sh/docs/mcp): Paseo-owned tool injection with separate credentials and settings; deliberately not duplicated here.
- [TypeScript SDK](https://paseo.sh/docs/sdk): daemon clients, subscriptions, agents, workspaces, and terminals.
- [Paseo plugins](https://paseo.sh/docs/plugins/hooks): host lifecycle hooks and app UI, not Pi-side extension hooks.

The initial tool intentionally excludes schedules, browser automation, plugin/configuration management, and custom native timeline adapters.

## Validation

From this directory, `npm run check` runs typechecking and local HTTP/subprocess tests, plus diagnostic bounds, concurrent-process overwrite, checksum, privacy, failure, and writer-backlog, interpreter-contract, and blocked-shutdown tests. Root `test/paseo.test.ts` exercises actual Pi lifecycle, dialogs, toggles, reloads, a deterministic foreground subagent-shaped tool, diagnostic correlation, and child/native boundaries in isolated homes; the packed suite repeats it against the installed tarball. No real Paseo daemon or live model provider is used. Windows launch-contract tests run on every OS with mocked filesystem/process boundaries. Subprocess tests use a POSIX executable wrapper on POSIX and a copied Node executable in a synthetic Paseo layout on Windows; they exercise argument preservation, cancellation, and capture limits without a daemon. Run this module's `npm run check` on Windows to verify native process behavior. The synthetic layout does not verify Electron's ASAR loading. Desktop/mobile clients, OS notifications, real Electron/ASAR launches, and a real Paseo deployment require separate validation.
