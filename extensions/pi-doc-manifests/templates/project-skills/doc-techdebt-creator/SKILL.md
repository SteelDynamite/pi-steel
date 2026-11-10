---
name: doc-techdebt-creator
description: "Record or substantially revise intentionally deferred project deficiencies, risks, or awkwardness."
---

# Tech Debt Documents

1. Read `.agents/docs/TECHDEBT.md` completely, then search `.agents/docs/techdebt/` for the same deficiency.
2. Record only a known deficiency the project knowingly leaves unresolved. Keep this record authoritative while remediation is in progress; do not create a duplicate feature merely because work starts.
3. Update an existing record when it covers the debt. Otherwise create a uniquely named kebab-case file with `priority: p3` unless its relative urgency deliberately differs.
4. Use `status: backlog` until retirement work starts and `in-progress` only while it is underway. State the present deficiency, impact, deferral tradeoff, and observable retirement condition.
5. Validate the result against `TECHDEBT.md`. Delete the record when its retirement condition is met, preserving durable outcomes where appropriate.

Use this complete shape. Replace comments; do not retain them.

```md
---
description: "When this applies and its primary guidance; when supporting detail must be read."
priority: p3
status: backlog
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
