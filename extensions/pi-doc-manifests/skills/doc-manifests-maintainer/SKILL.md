---
name: doc-manifests-maintainer
description: "Audit and maintain an existing pi-doc-manifests project. Use for stale creator skills, ineffective descriptions, metadata or guidance drift, structural diagnostics, or consolidating categories."
---

# Documentation Manifest Maintenance

1. Read project instructions, the injected manifest, relevant document bodies, and the creator skills declared by affected categories.
2. Read [shared guidance](../../src/AGENTDOCS.md), [package behavior](../../README.md), [category design](../doc-manifests-designer/SKILL.md), and relevant [templates](../../templates/). They express defaults, not permission to overwrite intentional project-specific choices.
3. Audit for:
   - missing or invalid `doc-manifest.creator-skill` associations and exact project-local skill files;
   - descriptions that omit applicability or useful primary guidance, or require a body read when the description could suffice;
   - creator skills, category boundaries and validation that disagree with intended authoring behavior;
   - source summaries, logs, dated evidence, session history, brittle source references, or duplicated routing;
   - source referring to agent documentation or skills;
   - unused metadata, including keyword requirements, and legacy `.pi-doc-manifests-layout-version` markers or `doc-manifest.version` fields;
   - default approval gates where project instructions impose none.
4. Distinguish **mechanical** corrections from **semantic** questions and **structural** changes. Use `doc-manifests-designer` for structural work and affected category creator skills for substantive document changes. Act autonomously within clear project intent; ask when intent is unclear or project instructions require approval.
5. Reconcile declarations, documents and skills together. Remove unused metadata and obsolete guidance without discarding useful current knowledge. Preserve intentional custom rules and approval gates. Do not mistake a difference from a shipped template for a defect.
6. Validate declarations and documents, check links, and run `git diff --check` when Git is available. Verify the next generated manifest has no unexpected diagnostics; reload Pi resources when skills change. Report changed files, preserved customization and unresolved choices.

## Optional category consolidation

Existing Decisions, Policies, numbered filenames and custom categories remain supported; their presence is not a defect. Do not use `/doc-manifests init` to upgrade an existing tree.

1. Read the categories, creator skills and document bodies. Confirm consolidation serves project intent rather than enforcing the example taxonomy. Follow project-specific gates and ask about ambiguous scope.
2. Prepare an old-to-new path map. Check destination and case-insensitive collisions, including nested paths, before moving files. Protect affected files outside the scanned tree when recovery is needed, including Git-ignored files.
3. Preserve useful current meaning, not chronology. For Standards, use the three ordered sections in its creator skill, distinguishing requirements from preferences. Do not invent missing rationale. Remove redundant metadata and update references and creator-skill associations together.
4. Remove replaced declarations and unused creator skills only after checking current knowledge and references. Leave existing session data untouched. Validate the result and reload resource discovery for changed skills. If already consolidated, leave it unchanged.
