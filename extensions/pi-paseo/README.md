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

## Settings

| Command | Effect |
| --- | --- |
| `/paseo` | Dialog with status and control-tool choices. |
| `/paseo status` | Show detection, activity health, and tool setting. |
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

Use full IDs from list results: agents/terminals use UUIDs; workspaces use `wks_` followed by 16 hexadecimal digits. No fuzzy names, prefixes, bulk stop, arbitrary flags, or model-selected daemon target. Explicit workspace IDs avoid ambiguity when workspaces share a directory.

Calls have a 30-second deadline and 1 MiB capture cap **per stream**; displayed output is limited to 50 KiB/2000 lines. Discarded output is not saved. Truncated output can be incomplete JSON. Known environment secrets and credential-bearing URLs are redacted, but terminal output and agent details can contain other sensitive data; enabling control permits that data to enter Pi's conversation.

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

From this directory, `npm run check` runs typechecking and local HTTP/subprocess tests. Root `test/paseo.test.ts` exercises actual Pi lifecycle, dialogs, toggles, reloads, and child/native boundaries in isolated homes; the packed suite repeats it against the installed tarball. No real Paseo daemon or live model provider is used. Desktop/mobile clients, OS notifications, Windows/macOS, and a real Paseo deployment require separate validation; fake CLI tests are POSIX-based.
