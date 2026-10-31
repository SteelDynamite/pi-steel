---
name: doc-feature-creator
description: "Create or substantially revise current project feature documents, including completion distillation."
---

# Feature Documents

1. Read `.agents/docs/FEATURES.md` completely, then search `.agents/docs/features/` for related active work.
2. Update the existing document when it covers the work. Otherwise create one uniquely named kebab-case file.
3. Use `priority: p2` unless relative importance deliberately differs. Use `status: draft` while scope or product questions remain, `ready` when implementation can begin without clarification, and `in-progress` only during implementation.
4. State the intended outcome, constraints, proposed behavior, and observable acceptance criteria. Keep durable rules, decisions, procedures, lessons, and debt in their narrower homes.
5. Validate the result against `FEATURES.md`.
6. On completion, distill durable outcomes into the appropriate current documents, then delete the feature document. Features are temporary work records.

Use this complete shape. Replace comments; do not retain them.

```md
---
description: "When this document is relevant or must be read; what it provides."
priority: p2
status: draft
keywords:
  - relevant-term
---
# Feature Name

## Goal

<!-- State the intended user or project outcome and why it matters. -->

## Context

<!-- Describe current conditions, constraints, and implementation-relevant rationale not evident from source. -->

## Open Questions

<!-- List decisions preventing ready status; omit when none remain. -->

## Proposed Behavior

<!-- Define observable behavior, boundaries, and important interactions. -->

## Acceptance Criteria

<!-- List verifiable conditions that prove implementation is complete. -->
```
