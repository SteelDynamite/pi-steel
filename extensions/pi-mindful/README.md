# pi-mindful

Pi extension that turns agent working time into guided breathing.

## Behavior

- Shows a subtle breathing working indicator while Pi works.
- After a delay, shows a fancy breathing widget near the editor.
- Widget bars fill and texture animate outward from center.
- Stops immediately when the agent finishes.
- Suppresses UI in orchestrated Pi child sessions.

## Commands

```text
/mindful
/mindful status
/mindful on|off
/mindful exercise coherent|sigh|box|478
/mindful style aurora|pulse|ripples|dots|wave|random
/mindful delay 5
/mindful placement above|below
```

Config is stored at `~/.pi/agent/mindful.json`.

## Attribution

A Pi adaptation of [Mindful-Claude](https://github.com/halluton/Mindful-Claude) by Halluton, implemented and extended by SteelDynamite. The original creation request identified Mindful-Claude as the reference; this is not a Git-history fork. The breathing exercises and animation styles retain that provenance.

MIT licensed. `LICENSE` preserves the upstream notice from revision `05c28e009aa2722034eb2d5deb863cc05b4e1acd`.

## Install

```sh
pi install https://github.com/SteelDynamite/pi-mindful.git
```
