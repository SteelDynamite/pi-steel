---
name: herdr-delegation
description: Delegate tasks to helper agents, coordinate their work, and manage background commands or terminals inside Herdr (hc).
---
# Herdr delegation

The installed `hc --skill` manual and current session values are already included below. Use them directly: do not reread this guide, rerun `hc --skill`, or query the supplied environment values. This is `hc`, not the older `herdr` TUI. For app windows or layouts, run and read `herdr-app --skill` only when needed.

If template discovery or command help is still needed, batch independent lookups in one shell call. Reuse their results within the session; fetch help only for syntax not covered by the supplied manual. Proceed to the requested work once the needed information is available.

Native `pi-subagent` delegation is inactive here. As the main agent, do small tasks yourself. For a bounded task worth delegating, use `hc` through the shell tool and prefer the matching installed Steel role:

- `steel-scout`: trace unfamiliar code and return file/line evidence without edits.
- `steel-worker`: implement a scoped change and report what changed.
- `steel-worker-visual`: inspect actual images, screenshots, or diagrams, including when implementing a change.
- `steel-reviewer`: review a change without edits **only when the person explicitly asked for review**.

Check `hc templates --json` once when you need a helper. Names are optional, not proof of installation: check the listed command uses the child marker and matches the supplied Pi agent directory. If missing or mismatched, do not install, overwrite, or run that name as a program. Use a suitable verified alternative or work directly. Helpers should not redelegate their task.

Launch the selected role with `hc run --bg --name <unique-name> --cwd <chosen-cwd> <template-name> <task>`. Put the scope, expected result, and **parent's literal terminal address** in the task as a single quoted argument; tell the helper to send results there. Check `first_message.sent` before treating the task as assigned.

For Pi helpers, explicitly set `PI_ORCHESTRATED_CHILD=1` and the supplied `PI_CODING_AGENT_DIR` in the launched command's environment. The supplied `HC_TERMINAL_ID` is the parent's reply address; let hc assign the child's identity. Quote values for the target shell. Choose the working directory and project trust deliberately; never bypass a permission prompt. Do not assume the core daemon inherits the caller's environment or parent `-e` flags.

Use the selected Herdr template's settings, or the launched agent's defaults. Parent model, thinking effort, and temporary speed selections are not automatically inherited. Do not silently copy or change them.

If `hc` fails, report the blocker; do not claim a helper ran or silently substitute native delegation. After repairing `hc`, use `/reload` to recheck availability. Never install/update Herdr or restart its core without approval.

Upstream manual and installation: https://herdr.dev/core/
