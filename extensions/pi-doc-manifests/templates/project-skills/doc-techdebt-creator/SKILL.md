---
name: doc-techdebt-creator
description: "Record or substantially revise intentionally deferred project deficiencies, risks, or awkwardness."
---

# Tech Debt Documents

1. Read `.agents/docs/TECHDEBT.md` completely, then search `.agents/docs/techdebt/` for the same deficiency.
2. Record only a known deficiency the project knowingly leaves unresolved. Active fixes belong in features; recurring fixes belong in lessons or runbooks.
3. Update an existing record when it covers the debt. Otherwise create a uniquely named kebab-case file with `priority: p3` unless its relative urgency deliberately differs.
4. Use `status: backlog` until retirement work starts and `in-progress` only while it is underway. State the present deficiency, impact, deferral tradeoff, and observable retirement condition.
5. Validate the result against `TECHDEBT.md`. Delete the record when its retirement condition is met, preserving durable outcomes where appropriate.

Use this complete shape. Replace comments; do not retain them.

```md
---
description: "When this document is relevant or must be read; what it provides."
priority: p3
status: backlog
keywords:
  - relevant-term
---
# Debt Name

## Debt

<!-- Describe the current deficiency, risk, or awkwardness left unresolved. -->

## Impact

<!-- Explain present costs, risks, and affected work. -->

## Why we took it

<!-- State the constraint or tradeoff that currently justifies deferral. -->

## Retirement condition

<!-- Define an observable condition that requires or proves resolution. -->
```
