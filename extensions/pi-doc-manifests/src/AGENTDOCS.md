These documents preserve current project knowledge: non-obvious facts, constraints, decisions, pitfalls and useful synthesis across sources. They do not mirror source files or session history. Git owns history; documentation preserves the relationships and rationale needed to act correctly.

References are one-way: documentation and skills may reference project code; project code, including comments, must not reference agent documentation or skills.

Always read documents relevant to the task before acting. Proactively suggest creating, revising, distilling or deleting documents when facts change, when doing so would preserve implicit knowledge, or when it would improve future work. Explicit user approval is required to create new documents; a coding request or general instruction to preserve knowledge is not approval to create new documents. Always load the `doc-manifests-designer` skill before organizing `.agents/docs` or changing a category or manifest. Additionally, every category declares a project-local creator skill; load it before creating or substantially revising documents in that category.

Each document description is an active routing instruction, not merely a summary: state when the document is relevant, whether it must be read before acting, and what context, rule, or procedure it provides.

This manifest is injected automatically; avoid duplicating its routing elsewhere.