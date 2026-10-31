---
doc-manifest:
  creator-skill: doc-feature-creator
  priorities: true
  display-fields: [status]
  validation:
    frontmatter:
      status:
        type: enum
        values: [draft, ready, in-progress]
      keywords:
        type: string[]
    required-sections: [Goal]
    filename-pattern: "**/*.md"
---
Planned and prioritized implementation work. Distill durable outcomes and delete the record when implementation is complete.
