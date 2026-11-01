# pi-steel development

## Scope

- Develop `SteelDynamite/pi-steel` in `/projects/repos/pi-steel`: one distributable Pi package with independently selectable extensions and a loadout manager, not one coupled extension or a general package registry.
- Keep modules under `extensions/<existing-package-name>/`. Preserve their tests, assets, licenses, attribution, configuration paths, and persisted identities. Use `extensions.manifest.json` for provenance and companion ownership; do not duplicate its catalog in prose.
- Use ordinary `AGENTS.md` guidance, not repository/module locational ownership markers or mandatory source delegation. Preserve bundled behavioral `SUBAGENTS.md` definitions and test fixtures.

## Safety boundaries

- Develop and test in isolated homes/configuration. Changing active installations, settings, credentials, or package pins requires separate approval and a recovery path. Stage replacement caches on the destination filesystem before switching.
- Preserve unrelated manual packages and settings. Never let untrusted project package-manager settings control package lookup or installation; keep ownership and collision checks intact.
- Preserve behavioral agents, model-only subagent exposure, and orchestrated-child suppression. Locational behavior requires `PI_SUBAGENT_ENABLE_LOCATIONAL_AGENTS=1`; `includeLocationalAgents` cannot override it. Do not restore subagent slash-command prompt exports or conceal cross-installation discovery problems with broad exclusions.
- Automatic session supervisors must be bounded and suppressed by `PI_ORCHESTRATED_CHILD=1`.
- Preserve `/projects/repos/pi-extension-forge`, original source checkouts, old installations, and recovery assets. Repository retirement requires a verified inventory and explicit deletion approval. Never assume third-party repositories are disposable. Other environments are user-managed; do not investigate them without a request or infer global readiness from local checks.

## Implementation constraints

- Preserve the loadout contract documented in `README.md`: one active selection, owner-coupled companion resources, unrelated-resource preservation, and dynamic shipped definitions rather than copied defaults.
- Automatic synchronization changes disk, not the running extension set. Keep offline/child guards, explicit download confirmation, controlled command reloads, and request-local pending/error warnings. No background package updates, model turns to announce synchronization, lock stealing, or retry loops.
- Do not publish a persistent Steel footer status; leave that space for token speed and other extension statuses.
- Prefer supported Pi package APIs and resource filters over a custom loader. Recheck actual host behavior, including settings locking, when upgrading Pi; source types and mocks alone do not establish compatibility.
- Keep runtime dependencies available from the root distribution and host-provided Pi packages external. Preserve module-relative asset relationships and required compiled output; individual module packaging does not prove the root tarball works.
- Keep observational memory external, using explicitly updated upstream Git. Verify the actual loaded artifact on updates, not just merged source or npm status. The development lockfile is reproducible test input, not a runtime pin. Do not import the user's fork or automatically merge memory settings.

## Validation

- Read applicable module guidance and manifest-routed documents before changing behavior. Check installed Pi documentation and examples before relying on host APIs.
- Run relevant module checks from that module's directory. For distribution or integration changes, run `npm run check`, `npm run check:modules`, and `npm run check:packed`; follow README setup instructions.
- Use temporary homes and deterministic local providers. Live-provider tests require separate approval. Report skipped tests and untested environments explicitly; never infer that passing aggregate checks retires individual audit findings.
- Verify parent/child resource inheritance, actual packed assets, reload behavior, and UI coexistence where affected. Children do not inherit arbitrary parent `-e` flags.
- Run `git diff --check`. After documentation changes, verify links and a fresh Pi session's manifest diagnostics; resumed sessions may retain old snapshots.

## Documentation and repository hygiene

- Keep this file limited to concise, current operating instructions. Do not add work logs, completion narratives, deployment history, commit inventories, CI links, test counts, or dated validation reports.
- `README.md` describes the product for humans. Put consequential rationale in Standards, repeatable procedures in Runbooks, and unresolved risks in Techdebt. Preserve evidence only when it changes a future decision; discard redundant history instead of relocating it wholesale.
- Use the injected manifest to route local project memory under `.agents/docs/`. Load the category's creator skill before substantive changes. Do not invent categories or a parallel index without approval.
- `.agents/` is local-only. Before deleting a record, distill only necessary current knowledge into its proper home; Git does not preserve these records. Keep Standards filenames unnumbered and sections appropriate to their content.
- Never stage or commit `.agents/`, secrets, personal Pi settings, credentials, sessions, or dependency trees. Never bypass their ignore rules.
