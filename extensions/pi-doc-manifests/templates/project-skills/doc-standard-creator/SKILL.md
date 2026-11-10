---
name: doc-standard-creator
description: "Create or revise project standards explaining consequential design guidance, scope, intentions and tradeoffs."
---

# Standard Documents

1. Read `.agents/docs/STANDARDS.md`, then search `.agents/docs/standards/` for the same guidance. Update the narrowest existing document when possible.
2. Capture consequential current guidance, not implementation tasks or chronology. Update, distill or delete it as the project changes, preserving necessary current rationale.
3. Use a uniquely named, unnumbered kebab-case file. Its description should convey applicability and primary guidance; require reading the body only when its supporting detail is needed.
4. Use exactly the three H2 headings below, in this order. Short sections are valid; use topic-specific subheadings when needed.
5. Put obligations under Standard and applicability under Scope and exceptions; do not bury either in rationale. Preserve qualifying context without repeating it across sections. Keep repeatable procedures in runbooks and API contracts with their source; link rather than duplicate them. Prefer stable source references over line numbers or incidental details.
6. Validate against `STANDARDS.md` and check heading order. Respect project-specific approval rules; do not invent additional gates.

Use this shape. Replace comments; do not retain them.

```md
---
description: "When this applies and its primary guidance; when supporting detail must be read."
---
# Standard Title

## Standard

<!-- Distinguish requirements (must, must not) from preferences (prefer). Do not turn a recommendation or incidental implementation into a mandate, or weaken an existing requirement. -->

## Scope and exceptions

<!-- Explain where the guidance applies and any exceptions needed to interpret it correctly. -->

## Rationale and tradeoffs

<!-- Explain the intentions, problems prevented and accepted costs that affect future decisions. If the rationale is missing, ask the owner rather than inventing it or filling this section with generic advice. -->
```
