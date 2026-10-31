---
doc-manifest:
  creator-skill: doc-techdebt-creator
  priorities: true
  validation:
    frontmatter:
      status:
        type: enum
        values: [backlog, in-progress]
      keywords:
        type: string[]
    required-sections: [Debt, Impact, Why we took it, Retirement condition]
    filename-pattern: "**/*.md"
---
Necessary work intentionally postponed for a documented reason. Delete the record when its retirement condition is met, preserving durable outcomes where appropriate.
