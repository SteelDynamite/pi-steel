# pi-steel development

## Identity and direction

- Public repository and product: `SteelDynamite/pi-steel`.
- Local development workspace: `/projects/repos/pi-steel-forge`.
- Build one distributable Pi package containing independently selectable extensions and a loadout manager. Do not turn the collection into one coupled extension.
- Optimize for a personal collection used across multiple environments, not a general package registry.

## Approved loadout contract

- Exactly one active named loadout; no stacking or overrides initially.
- Loadouts select bundled and external extensions only. Managing skills, prompts, themes, arbitrary settings, or credentials is out of scope.
- Users may install and remove unrelated extensions through ordinary Pi commands. Preserve those installations during synchronization and loadout changes.
- The selected loadout owns its members. Manually removing a member creates drift; an explicit sync restores it. Permanent exclusion requires changing or selecting a loadout.
- No automatic startup installation, update, removal, or reconciliation. Apply changes through explicit commands.
- Prefer Pi's supported package APIs, resource filters, and controlled reload over a custom extension loader. Confirm current host behavior before implementation.
- Keep inactive members installed but unloaded where supported. Report partial failures accurately and make repeated synchronization idempotent.
- Storage format, command names, version pinning, scope precedence, and shared ownership with manually installed packages remain design questions, not implemented guarantees.

## Migration and retirement

This is a new project identity, not a second permanent implementation. Migrate existing code and tests rather than rewrite working extensions.

The predecessor is `/projects/repos/pi-extension-forge`. Until an approved inventory is recorded here, its `extensions.manifest.json` remains authoritative for managed source repository identities. Do not copy a second repository catalog into prose. The existing `.agents/docs/features/personal-extension-packs-manager.md` contains earlier research; the approved contract above supersedes its unresolved choice of architecture and scope.

1. Inventory currently used extensions, external dependencies, tests, resources, licenses, and source revisions. Distinguish first-party migration candidates from external packages and archived or unused repositories. Do not assume the managed manifest alone describes everything the user uses.
2. Agree on module layout and history/provenance preservation before imports. Preserve license and attribution obligations; public repository visibility is not a license grant.
3. Import modules with their tests and supporting assets. Preserve existing behavior and intentional safety boundaries, including model-only exposure for the subagent tool.
4. Implement and verify the loadout manager in an isolated Pi environment. Do not alter the user's active installation during development.
5. Validate fresh bootstrap, loadout switching, unrelated-package preservation, external-package coexistence, idempotency, partial failure, and reload behavior. Prove the user's actual extension set works before cutover.
6. Cut over deliberately with a recovery path. Prevent duplicate loading from old individual installations and new bundled modules.
7. Once pi-steel is proven and everything the user uses is migrated, retire the predecessor project and superseded first-party repositories. Deletion requires a verified inventory and explicit user approval at that time. Do not delete third-party repositories or assume every predecessor-associated repository is disposable.

Keep the predecessor operational until cutover. Do not propagate its separate-repository architecture or startup synchronization into this monorepo by default. Any automatic supervisor must suppress behavior when `PI_ORCHESTRATED_CHILD=1`.

## Documentation and repository hygiene

- `README.md` is human-facing: describe the product and its actual readiness, not agent workflow.
- Keep development constraints and migration guidance here until a project-specific documentation structure is approved. Do not invent documentation categories or a parallel index without approval.
- Never stage or commit `.agents/`, secrets, personal Pi settings, credentials, sessions, or local dependency trees.
- Check `git diff --check` after edits and verify a fresh Pi session has no manifest diagnostics after documentation changes.
