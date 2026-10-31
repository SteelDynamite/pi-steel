---
name: doc-decision-creator
description: "Create or revise a consequential decision explaining why current project behavior exists."
---

# Decision Documents

1. Read `.agents/docs/DECISIONS.md` completely, then search `.agents/docs/decisions/` for the same decision.
2. Update, replace, or delete a decision in place as the current design changes; version control preserves superseded history. Do not maintain an immutable decision chain.
3. For a new decision, choose the next unused four-digit kebab-case filename, such as `0001-subject.md`.
4. Describe the current problem, realistic alternatives with explicit tradeoffs, selected design, and consequences. Keep procedures and future-applying rules in runbooks and policies.
5. Validate the result against `DECISIONS.md`.

Use this complete shape. Replace comments; do not retain them.

```md
---
description: "When this document is relevant or must be read; what it provides."
keywords:
  - relevant-term
---
# Decision Title

## Context

<!-- Describe the current problem, relevant forces, and facts not evident from source. -->

## Options considered

<!-- Compare realistic choices and tradeoffs that explain the current decision. -->

### Option Name

<!-- Briefly explain one candidate. -->

- Good: <!-- Meaningful advantages. -->
- Bad: <!-- Meaningful costs or risks. -->

## Decision

<!-- State the current choice and decisive rationale. -->

## Consequences

<!-- Describe constraints, costs, and opportunities created by the decision. -->
```
