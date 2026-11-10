---
name: doc-runbook-creator
description: "Create, improve or troubleshoot a repeatable procedure for a specific project outcome."
---

# Runbook Documents

1. Read `.agents/docs/RUNBOOKS.md`, then search `.agents/docs/runbooks/` for an existing procedure. Update it when it applies; otherwise use a uniquely named kebab-case file.
2. Document work a person or agent actually performs, not automatic source behavior. Write a description that conveys the outcome, scope and primary guidance; require the body when execution needs its details.
3. Choose READ–DO or DO–CONFIRM explicitly. Make consequential decisions and easily missed steps clear without adding checks to every step.
4. After use, directly apply improvements supported by the experience. Preserve actual approval boundaries and follow project-specific gates without inventing new ones. Record the improved procedure, not an execution log.
5. Validate against `RUNBOOKS.md`.

Use this shape. Replace comments; do not retain them.

```md
---
description: "When this applies and its primary guidance; when supporting detail must be read."
---
# Procedure Name

## Goal

<!-- State the outcome and scope. Use a concise version as the frontmatter description, including primary guidance and any need to read the procedure. -->

## Preconditions

<!-- Identify required conditions, input sources, tools and access. Include platform and working-directory assumptions when they affect execution. -->

## Steps

<!-- State whether this uses READ–DO (ordered actions performed as they are read) or DO–CONFIRM (familiar work performed first, followed by a short check of critical items). For DO–CONFIRM, write confirmation items, not instructions to repeat completed work.

Make consequential decisions and easily missed steps explicit. Before irreversible actions or handoffs, state effects, required observations and conditions for proceeding. Checks should prevent concrete mistakes, not accompany every step. Preserve actual approval boundaries without inventing gates. -->

## Verification

<!-- Specify observable outcomes for affected paths, broadening coverage for shared changes. Repeat intermediate checks only when the final state needs reconfirmation. -->

## Troubleshooting

<!-- Map likely symptoms to specific recovery actions. -->
```
