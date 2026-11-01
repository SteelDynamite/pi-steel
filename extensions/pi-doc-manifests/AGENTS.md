# AGENTS.md

## Layout

- `index.ts`: Pi session hook and `/doc-manifests init` command.
- `src/init.ts`: no-overwrite layout initializer.
- `src/manifest.ts`: category-agnostic scanner and renderer.
- `skills/`: package-global manifest design, maintenance, and session-review guidance.
- `templates/`: optional example initialization guides and category-specific project-local skills.
- `test/`: logic and filesystem tests.

## Workflow

1. Keep scanning confined to `ctx.cwd/.agents/docs` plus exact creator-skill files declared there, gated by project trust, and category-agnostic. Categories derive from project responsibilities rather than a predefined taxonomy.
2. Every paired guide must declare `doc-manifest.creator-skill`; require a regular `.agents/skills/<name>/SKILL.md` with matching skill name and non-empty description. Trusted runtime scanning accepts linked directory ancestors, including a junctioned `.agents`, but not a linked `SKILL.md`; initialization remains stricter because it writes. Keep this invariant aligned across runtime diagnostics, initialization, injected guidance, designer, maintainer, and session reviewer.
3. Keep the injected prompt and generic skills aligned: agents require explicit user approval before creating, renaming, merging, or deleting categories; materially expanding category responsibility; or making validation changes that invalidate existing documents. Session review must route from the injected manifest and load a category creator skill only after identifying a candidate.
4. Initialization copies optional example templates only after checking canonical cwd, target ancestors, symlinks, and every target for conflicts. Never merge or overwrite. The maintainer skill owns collaborative upkeep of initialized projects. Standards is an optional initialization default, not a required runtime category. Preserve existing Decisions/Policies projects and numbered filenames; merging them is an approved, agent-guided operation, never a startup migration. Standards uses flexible sections rather than combining the former heading requirements.
5. Keep manifest rendering deterministic; do not add output limits. Runtime dependencies are YAML and minimatch. Declarations use one live schema; silently ignore legacy `version` fields.
6. Snapshots are unversioned `doc-manifests` custom entries, not custom messages; retain ordinary branch restore and accept legacy entries with string `content`. Wrap only the system-prompt copy in extension-owned `<docs-manifest>` tags and escape authored wrapper-like tags; stored and TUI content remain Markdown. Successful initialization must rebuild from disk and append its new snapshot.
7. Run before delivery:

```sh
npm test
npm run typecheck
npm run pack:check
```

Do not commit or publish unless explicitly asked.
