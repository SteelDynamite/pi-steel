# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Renamed the repository, package, and extension to `pi-subagent`, and the public tool to `subagent`, as a hard break.
- Reduced each tool call to one behavioral or locational agent with explicit session intent.
- Removed shell-command, batch, chain, scope, compatibility-alias, and behavioral-cwd inputs; built-in `bash` owns commands.
- Added implicit bundled/user/trusted-project behavioral precedence and trusted locational discovery.
- Renamed locational state, environment variables, settings, nested progress, and the TUI manifest.
- Delegated children now set only `PI_ORCHESTRATED_CHILD=1`.
- Refocused behavioral roles: parent orchestrators plan, Scout gathers context, Worker executes, and Reviewer reviews only when explicitly requested.
- Revised `/implement` for the parent-owned planning flow.

## 0.0.3 - 2026-08-15

- Simplified the shared locational manifest to one absolute-path and description bullet per agent.

## 0.0.2 - 2026-08-15

- Changed the locational area card and model prompt to use one full canonical routing string with identical expanded and collapsed display.

## 0.0.1 - 2026-08-15

- Added a durable, compact TUI-only `[areas]` card sourced from canonical locational-agent discovery.
- Set the bundled Scout behavioral agent model to `gpt-5.6-luna`.
- Removed the bundled Spark behavioral agent.
- Added MIT license metadata and LICENSE file.
