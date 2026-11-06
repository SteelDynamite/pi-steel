---
name: herdr-delegation
description: Delegate tasks to helper agents, coordinate their work, and manage background commands or terminals inside Herdr (hc).
---
# Herdr delegation

The installed `hc --skill` manual and current session values are already included below. Use them directly: do not reread this guide, rerun `hc --skill`, or query the supplied environment values. This is `hc`, not the older `herdr` TUI. For app windows or layouts, run and read `herdr-app --skill` only when needed.

If template discovery or command help is still needed, batch independent lookups in one shell call. Reuse their results within the session; fetch help only for syntax not covered by the supplied manual. Proceed to the requested work once the needed information is available.

Native `pi-subagent` delegation is inactive here. Use `hc` through the shell tool; existing behavioral `SUBAGENTS.md` definitions are not applied or converted into Herdr templates.

For Pi helpers, explicitly set `PI_ORCHESTRATED_CHILD=1` and the supplied `PI_CODING_AGENT_DIR` in the launched command's environment. The supplied `HC_TERMINAL_ID` is the parent's reply address; let hc assign the child's identity. Quote values for the target shell. Choose the working directory and project trust deliberately; never bypass a permission prompt. Do not assume the core daemon inherits the caller's environment or parent `-e` flags.

Use the selected Herdr template's settings, or the launched agent's defaults. Parent model, thinking effort, and temporary speed selections are not automatically inherited. Do not silently copy or change them.

If `hc` fails, report the blocker; do not claim a helper ran or silently substitute native delegation. After repairing `hc`, use `/reload` to recheck availability. Never install/update Herdr or restart its core without approval.

Upstream manual and installation: https://herdr.dev/core/
