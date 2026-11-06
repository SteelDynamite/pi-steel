---
name: herdr-delegation
description: Delegate tasks to helper agents, coordinate their work, and manage background commands or terminals inside Herdr (hc).
---
# Herdr delegation

Run `hc --skill` before using Herdr; read and follow its output. For app windows or layouts, also run and read `herdr-app --skill`. This is `hc`, not the older `herdr` TUI.

Native `pi-subagent` delegation is inactive here. Use `hc` through the shell tool; existing behavioral `SUBAGENTS.md` definitions are not applied or converted into Herdr templates.

For Pi helpers, explicitly set `PI_ORCHESTRATED_CHILD=1` and the intended `PI_CODING_AGENT_DIR` in the launched command's environment. Choose the working directory and project trust deliberately; never bypass a permission prompt. Do not assume the core daemon inherits the caller's environment or parent `-e` flags.

Use the selected Herdr template's settings, or the launched agent's defaults. Parent model, thinking effort, and temporary speed selections are not automatically inherited. Do not silently copy or change them.

If `hc` fails, report the blocker; do not claim a helper ran or silently substitute native delegation. After repairing `hc`, use `/reload` to recheck availability. Never install/update Herdr or restart its core without approval.

Upstream manual and installation: https://herdr.dev/core/
