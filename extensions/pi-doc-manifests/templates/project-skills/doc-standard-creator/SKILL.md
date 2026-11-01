---
name: doc-standard-creator
description: "Create or revise project standards explaining consequential design choices, intentions, tradeoffs, or mandatory conventions."
---

# Standard Documents

1. Read `.agents/docs/STANDARDS.md` completely, then search `.agents/docs/standards/` for the same choice or rule. Update the narrowest existing document when possible.
2. Capture consequential current design or reusable mandatory behavior, not implementation tasks or chronology. Keep procedures in runbooks.
3. Update, replace, or delete standards as the design changes; do not maintain an immutable decision chain. Preserve needed rationale and evidence before removing material, especially when records are not version-controlled.
4. Use a uniquely named, unnumbered kebab-case file. Numbering implies an order these current standards do not need.
5. Choose sections to fit the content, not a mandatory combined shape:
   - For a design choice, explain context, intentions, realistic alternatives and tradeoffs, the chosen design, and consequences.
   - For a rule, state mandatory behavior, scope, necessary exceptions, and rationale that changes future judgment.
   - Combine both when they concern the same subject; do not invent alternatives for a simple rule or rules for an explanatory choice.
6. Validate the result against `STANDARDS.md`.

Start with this metadata and add only useful sections:

```md
---
description: "When this document is relevant or must be read; what it provides."
keywords:
  - relevant-term
---
# Standard Title
```
