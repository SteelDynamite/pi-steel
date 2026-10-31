---
name: doc-policy-creator
description: "Create or substantially revise a durable project rule future agents and contributors must follow."
---

# Policy Documents

1. Read `.agents/docs/POLICIES.md` completely, then search `.agents/docs/policies/` for the narrowest existing rule.
2. Create a policy only for reusable future behavior, not feature-specific implementation detail or historical rationale. Update the narrowest existing document when possible.
3. State mandatory behavior directly, define its scope, and include only bounds or rationale that change future decisions. Link a decision when it usefully supplies rationale.
4. Use a uniquely named kebab-case file when a new policy is necessary.
5. Validate the result against `POLICIES.md`.

Use this complete shape. Replace comments; do not retain them.

```md
---
description: "When this document is relevant or must be read; what it provides."
keywords:
  - relevant-term
---
# Policy Name

## Rule

<!-- State mandatory future behavior directly and unambiguously. -->

## Applies to

<!-- Define exact repositories, artifacts, or workflows governed by the rule. -->

## Bounds

<!-- Define necessary exceptions or edge conditions; omit when none exist. -->

## Rationale

<!-- Explain why the rule exists only when that reasoning changes future judgment. -->
```
