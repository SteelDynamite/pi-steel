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
3. Keep the preamble, generic skills and templates aligned: documentation work is autonomous unless project instructions impose approval gates. Descriptions carry primary guidance where sufficient; retrieve bodies for required or questioned details. Treat project source broadly, use optional stable references, and exclude source summaries, logs, dated evidence, session history and keyword metadata. Session review loads a creator skill only after identifying a candidate.
4. Initialization copies optional example templates only after checking canonical cwd, target ancestors, symlinks, and every target for conflicts. Never merge or overwrite. The maintainer skill owns collaborative upkeep of initialized projects. Standards is an optional initialization default, not a required runtime category. Preserve existing Decisions/Policies projects and numbered filenames; merging them is an approved, agent-guided operation, never a startup migration. New Standards use three ordered H2 sections: Standard, Scope and exceptions, Rationale and tradeoffs. Preserve requirements versus preferences and ask about unknown rationale. Existing project declarations remain authoritative until agent-guided maintenance reconciles them.
5. Keep manifest rendering deterministic; do not add output limits. Runtime dependencies are YAML and minimatch. Declarations use one live schema; silently ignore legacy `version` fields.
6. Rebuild from trusted disk on every `context_with_system` request, including tool loops and after compaction. Replace only the owned `pi_doc_manifests` section, clearing stale later patches and preserving all other system/tool fields. Never use display records as prompt state. Keep unversioned `doc-manifests` custom entries for lifecycle display and legacy rendering; avoid duplicate unchanged entries and per-turn history writes. Wrap only the prompt copy in `<docs-manifest>` and escape authored wrapper-like tags. Verify coexistence with named-section contributions from subagent and system-reminders; whole-prompt overrides discard request-local sections.
7. Run before delivery:

```sh
npm test
npm run typecheck
npm run pack:check
```

Do not commit or publish unless explicitly asked.
