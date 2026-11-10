---
name: doc-manifests-designer
description: "Design or reorganize project-specific .agents/docs categories, creator skills, and paired pi-doc-manifests. Use when placing durable project memory, changing manifest validation, moving loose documentation, or resolving structural diagnostics."
---

# Documentation Manifest Design

1. Inspect project instructions and the injected manifest. When no manifest is injected, read [the shared guidance](../../src/AGENTDOCS.md). Read relevant existing category declarations and their project-local creator skills before choosing a destination.
2. Treat categories as discovered project responsibilities, not a predefined or exhaustive taxonomy. Reuse a category only when its declared responsibility fits. Load its creator skill before creating or substantially revising documents.
3. When no category fits, define a narrow responsibility, boundaries, candidate documents and creator workflow. Create, reorganize or remove categories as needed under project instructions; do not invent approval gates. Ask when intent is unclear or a project-specific gate applies.
4. Pair each direct, real, non-hidden folder with an exact uppercase sibling `<FOLDER>.md`. Its body is the injected responsibility declaration, not an index. Declare `doc-manifest.creator-skill` naming an exact `.agents/skills/<name>/SKILL.md` with matching `name`, non-empty `description` and concise authoring guidance.
5. Add only useful priority, display or validation settings. Before changing scope or validation, inspect affected documents and preserve their necessary current knowledge. Do not weaken useful rules merely to silence diagnostics or leave documents invalid after changing their declaration.
6. Keep documents inside paired folders. Descriptions are active routing instructions, not merely summaries: state applicability and convey primary guidance where practical. A description may suffice; require the body only when supporting detail is needed or questioned. Avoid loose root Markdown, orphan declarations and unpaired folders.
7. Keep source references optional and stable. Do not copy source, logs, dated evidence or session history into documentation. Prefer revision or distillation over duplicating current knowledge.
8. Validate changed documents and creator skills, check links, and run `git diff --check` when Git is available. Verify the next generated manifest has no unexpected diagnostics; reload Pi resources when skills change.
