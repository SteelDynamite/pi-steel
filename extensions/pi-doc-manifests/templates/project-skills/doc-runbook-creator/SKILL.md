---
name: doc-runbook-creator
description: "Create or substantially revise a repeatable project procedure or troubleshooting runbook."
---

# Runbook Documents

1. Read `.agents/docs/RUNBOOKS.md` completely, then search `.agents/docs/runbooks/` for an existing procedure.
2. Document work a person or agent actually performs; automatic behavior belongs in source or a decision document.
3. Update the existing procedure when it applies. Otherwise use a uniquely named kebab-case file.
4. Make steps executable, verification observable, and troubleshooting specific to likely failures.
5. Validate the result against `RUNBOOKS.md`.

Use this complete shape. Replace comments; do not retain them.

```md
---
description: "When this document is relevant or must be read; what it provides."
keywords:
  - relevant-term
---
# Procedure Name

## Goal

<!-- State the observable outcome this procedure produces. -->

## Preconditions

<!-- List required state, access, tools, and inputs. -->

## Steps

<!-- Give ordered, executable instructions with decision points where needed. -->

## Verification

<!-- Provide observable checks proving the procedure succeeded. -->

## Troubleshooting

<!-- Map likely symptoms to specific recovery actions. -->
```
