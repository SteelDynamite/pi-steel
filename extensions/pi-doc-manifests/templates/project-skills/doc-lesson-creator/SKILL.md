---
name: doc-lesson-creator
description: "Capture or revise a recurring project problem and its known fix."
---

# Lesson Documents

1. Read `.agents/docs/LESSONS.md` completely, then search `.agents/docs/lessons/` for the same failure or fix.
2. Create a lesson only when investigation is likely to recur and no policy already prevents it. Update the existing document when it covers the problem.
3. Use a uniquely named kebab-case file. Explain recognizable symptoms, the supported cause, the proven fix, and when it applies.
4. Promote repeated procedures to runbooks and preventative rules to policies.
5. Validate the result against `LESSONS.md`.

Use this complete shape. Replace comments; do not retain them.

```md
---
description: "When this document is relevant or must be read; what it provides."
keywords:
  - relevant-term
---
# Lesson Name

## Problem

<!-- Describe recognizable symptoms, evidence, and likely recurring conditions. -->

## Likely cause

<!-- Explain the best-supported theory; distinguish inference from verified facts. -->

## Fix

<!-- Give the best known proven solution or mitigation. -->

## When to use

<!-- State triggers, limits, and cases where this lesson does not apply. -->
```
