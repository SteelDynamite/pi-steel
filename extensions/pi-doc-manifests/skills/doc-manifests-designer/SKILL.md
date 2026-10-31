---
name: doc-manifests-designer
description: "Design or reorganize project-specific .agents/docs categories, creator skills, and paired pi-doc-manifests. Use when placing durable project memory, proposing or revising a category, changing manifest validation, moving loose documentation, or resolving structural diagnostics."
---

# Documentation Manifest Design

1. Inspect the project instructions, injected documentation manifest, and `.agents/docs/`. Read every existing category declaration relevant to the material and its declared project-local creator skill before choosing a destination.
2. Treat categories as discovered project responsibilities, not a predefined or exhaustive taxonomy. Reuse an existing category only when its declared responsibility genuinely fits. Load its declared creator skill before creating or substantially revising a document within unchanged scope.
3. When no category fits, propose a category before changing files. State its name, responsibility, boundaries, candidate documents, creator skill name and purpose, and only the validation needed to keep that collection coherent. Discuss the proposal with the user and require explicit approval before creating it.
4. Also require explicit approval before:
   - materially expanding a category's responsibility;
   - changing validation in a way that invalidates existing documents;
   - renaming, merging, or deleting a category.
5. After approval, create each category as a direct, real, non-hidden folder with an exact uppercase sibling `<FOLDER>.md`. The sibling body is the routing declaration injected into the prompt, not an index. Its `doc-manifest.creator-skill` must name an exact `.agents/skills/<name>/SKILL.md` with matching `name`, non-empty `description`, and concise instructions implementing the category's document workflow. Add other `doc-manifest` settings only for useful priorities, displayed fields, or validation.
6. Keep documents inside paired folders. Write each non-empty `description` as an active routing instruction, not merely a summary: state when the document is relevant, whether it must be read before acting, and what context, rule, or procedure it provides. Satisfy the category declaration. Do not create loose root Markdown, orphan declarations, or unpaired folders.
7. Non-breaking diagnostic fixes and document work within existing scope do not need separate approval. Adding an obvious association to an existing creator skill is mechanical; creating or materially revising a creator skill requires the user's approved intent. Do not weaken useful declarations merely to silence diagnostics.
8. Verify changed documents against their declarations, run `git diff --check` when Git is available, then use a fresh Pi session to confirm the rendered manifest has no unexpected diagnostics.
