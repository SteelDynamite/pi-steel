---
name: doc-manifests-maintainer
description: "Audit and collaboratively update an existing pi-doc-manifests project to current documentation intentions. Use for maintenance, missing or stale creator skills, summary-only document descriptions, legacy metadata, guidance drift, or merging Decisions and Policies into Standards."
---

# Documentation Manifest Maintenance

1. Read project instructions, the injected documentation manifest, `.agents/docs/`, and every creator skill declared by a category.
2. Read current package guidance in [`../../README.md`](../../README.md), [`../doc-manifests-designer/SKILL.md`](../doc-manifests-designer/SKILL.md), and relevant files under [`../../templates/`](../../templates/). Treat them as current intentions, not authority to overwrite project-specific choices.
3. Audit for:
   - every paired category declaring `doc-manifest.creator-skill` and the exact `.agents/skills/<name>/SKILL.md` existing with matching `name`, non-empty `description`, and guidance suited to the category;
   - generated creator skills that no longer express current intentions;
   - document descriptions that summarize content without routing when it is relevant or must be read;
   - category declarations or validation that no longer fit their documents;
   - legacy `.agents/docs/.pi-doc-manifests-layout-version` markers and `doc-manifest.version` fields;
   - duplicated routing outside the injected manifest.
4. Classify findings as:
   - **mechanical** — obsolete metadata, an obvious missing creator-skill association, or unchanged generated boilerplate;
   - **semantic** — descriptions, missing or customized creator skills, or guidance requiring project judgment;
   - **structural** — category responsibility, layout, or validation changes.
5. Present a numbered maintenance plan, identify customization and uncertainty, and ask the user to approve or revise the proposed changes before editing.
6. Apply only approved changes. Remove legacy markers and declaration versions. Add approved creator-skill associations and create or reconcile their concise project-local skills without replacing customization. Update unchanged generated artifacts directly. Read document bodies before revising their descriptions, and use the declared creator skill for substantive document changes.
7. Load `doc-manifests-designer` for structural findings and retain its explicit approval gates. Do not create, rename, merge, delete, or materially expand categories, or invalidate documents through validation changes, without approval.
8. Verify declarations and documents, run `git diff --check` when Git is available, and use a fresh Pi session to confirm the manifest has no unexpected diagnostics. Report changed files, preserved customization, and unresolved choices.

## Optional Decisions/Policies merge

Initialization now offers Standards for consequential design choices and mandatory conventions. Existing Decisions, Policies, numbered filenames, and custom categories remain supported; their presence is not a defect. Offer this migration when relevant, never apply it automatically or use `/doc-manifests init` to upgrade an existing tree.

1. Read both declarations, their creator skills, and document bodies; inspect any existing Standards category. Load `doc-manifests-designer`. Propose `standards/`, `STANDARDS.md`, and `doc-standard-creator` using the current templates, reconciled with project customization.
2. Present an old-to-new path map. Strip decision-number prefixes for unnumbered kebab-case names, preserving meaningful title text. Check destination and case-insensitive collisions, including nested paths; ask about conflicts rather than overwrite or silently consolidate documents. If already migrated, leave it unchanged.
3. Identify references in links, project instructions, and other creator skills. Propose flexible sections rather than combining the old required-heading lists. Preserve custom metadata and constraints unless their change is explicitly approved. Category merging does not require document merging or body rewrites.
4. Obtain approval for the complete plan before editing. Back up affected files outside the scanned docs/skills trees, including Git-ignored files; Git alone may not preserve them.
5. Apply the approved moves and declarations, reconcile the creator skill, and update current references. Preserve historical provenance paths and old session data. Remove replaced declarations, empty source directories, and old creator skills only after verifying document preservation and that no current references or category associations still need them.
6. Check the path map, content preservation, links, and validation; then start a new Pi session to verify the manifest and skill discovery. Reloading or resuming a session may retain its old manifest snapshot. Report backup location, conflicts left unresolved, and any intentionally retained categories or skills.
