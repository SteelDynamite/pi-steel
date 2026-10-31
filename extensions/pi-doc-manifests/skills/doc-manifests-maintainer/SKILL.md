---
name: doc-manifests-maintainer
description: "Audit and collaboratively update an existing pi-doc-manifests project to current documentation intentions. Use for maintenance, missing or stale creator skills, summary-only document descriptions, legacy metadata, or guidance drift."
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
