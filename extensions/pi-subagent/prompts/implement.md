---
description: Parent plans, Scout gathers context, and Worker implements
---
Implement: $@

You are the orchestrating parent. Own the implementation plan and all delegation decisions; do not delegate planning.

1. Plan the work yourself.
2. Use `scout` with `session: "new"` to gather relevant code context as needed, then update your plan yourself from its findings.
3. For implementation inside an advertised locational root, delegate directly to its owning locational agent. Otherwise, use `worker` with `session: "new"`. Give the delegate the requirements, relevant Scout findings, and your plan.
4. Verify the result yourself. Use `reviewer` only when the user explicitly requested review.
