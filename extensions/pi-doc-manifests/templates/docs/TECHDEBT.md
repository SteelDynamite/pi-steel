---
doc-manifest:
  creator-skill: doc-techdebt-creator
  priorities: true
  display-fields: [status]
  validation:
    frontmatter:
      status:
        type: enum
        values: [backlog, in-progress]
    required-sections: [Debt, Impact, Why we took it, Retirement condition]
---
Known deficiencies intentionally left unresolved, with reasons and observable retirement conditions. Keep the record authoritative during in-progress remediation; delete it when resolved, preserving useful current outcomes elsewhere.
