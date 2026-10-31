---
name: doc-glossary-creator
description: "Define or clarify a current project-specific term."
---

# Glossary Documents

1. Read `.agents/docs/GLOSSARY.md` completely, then search `.agents/docs/glossary/` for the term, aliases, and overlapping concepts.
2. Update an existing definition instead of creating a synonym or duplicate. Create a uniquely named kebab-case file only for a distinct term.
3. Define the current project-specific meaning, distinctions that prevent ambiguity, and relevant relationships. Omit generic dictionary definitions.
4. Validate the result against `GLOSSARY.md`.

Use this complete shape. Replace the comment; do not retain it.

```md
---
description: "When this document is relevant or must be read; what it provides."
---
# Term

<!-- Define the term's exact project-specific meaning and distinctions needed to prevent ambiguity. -->
```
