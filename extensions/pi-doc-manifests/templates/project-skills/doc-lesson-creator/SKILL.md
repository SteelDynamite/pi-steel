---
name: doc-lesson-creator
description: "Capture or revise recurring or likely-to-recur external-dependency problems and their supported explanations or mitigations."
---

# Lesson Documents

1. Read `.agents/docs/LESSONS.md`, then search `.agents/docs/lessons/` for the same failure or mitigation.
2. Record problems with external dependencies outside the project's control that recur or are likely to recur. Fix problems within the project's control instead of writing lessons about them.
3. Update an existing lesson when it covers the problem; otherwise use a uniquely named kebab-case file. Make its description convey when it applies and the primary guidance where practical.
4. Explain recognizable symptoms, the best-supported explanation, and the best-known solution or mitigation. A supported hypothesis and working mitigation are sufficient; distinguish uncertainty from verified facts rather than claiming a proven root cause.
5. Keep repeatable procedures in runbooks and preventative conventions in standards; link rather than duplicate them. Revise or delete a lesson when dependency behavior changes.
6. Validate against `LESSONS.md`.

Use this shape. Replace comments; do not retain them.

```md
---
description: "When this applies and its primary guidance; when supporting detail must be read."
---
# Lesson Name

## Problem

<!-- Describe recognizable symptoms and recurring or likely-to-recur conditions in an external dependency. -->

## Likely cause

<!-- Explain the best-supported theory; distinguish uncertainty from verified facts. -->

## Fix

<!-- Give the best-known solution or working mitigation, including its limits. -->

## When to use

<!-- State triggers and cases where this lesson does not apply. -->
```
