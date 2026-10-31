---
name: doc-goal-creator
description: "Create or revise a high-level project direction used to evaluate and prioritize work."
---

# Goal Documents

1. Read `.agents/docs/GOALS.md` completely, then search `.agents/docs/goals/` for the same direction.
2. Keep one current direction per uniquely named kebab-case file. Existence means active: update or delete the document in place as direction changes.
3. Do not add status, priority, or historical progression. A goal is an enduring direction, not an implementation task.
4. State the intended direction and how it changes evaluation, prioritization, and tradeoffs.
5. Validate the result against `GOALS.md`.

Use this complete shape. Replace comments; do not retain them.

```md
---
description: "When this document is relevant or must be read; what it provides."
keywords:
  - relevant-term
---
# Goal Name

## Intent

<!-- State the enduring direction and desired project state, not an implementation task. -->

## Implications

<!-- Explain how this direction changes evaluation, prioritization, and tradeoffs. -->
```
