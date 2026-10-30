# pi-steel

A personal Pi extension collection and loadout manager, distributed as one package.

## Planned behavior

- Keep extensions as independently selectable, testable modules in one monorepo.
- Select one named loadout containing bundled and external extensions.
- Install missing extensions and apply the selection through explicit manager commands.
- Preserve unrelated extensions installed through normal Pi package management.
- Keep inactive extensions installed but unloaded where supported.

The initial scope is extensions only, with no loadout stacking or per-environment overrides. Skills, prompts, themes, arbitrary settings, and credentials are not managed by loadouts.

## Status

Planning and migration bootstrap only. No extensions have been imported and the manager is not implemented. This repository is not yet an installable Pi package.
