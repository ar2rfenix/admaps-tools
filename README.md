# ADMaps Tools

A toolbox for Foundry VTT v13, built for [Animated Dungeon Maps](https://admaps.cloud/) scenes and useful on any map:
elevation regions (plateaus, stairs, water, transport), helpers for multi-floor scenes, roofs and doors, scene variations,
batch scene import and a set of editing tools.

Every tool has its own checkbox in the module settings, so you can keep only what you need.

## Requirements

- Foundry VTT v13
- [libWrapper](https://foundryvtt.com/packages/lib-wrapper) (required)
- Recommended: [Levels](https://foundryvtt.com/packages/levels), [Wall Height](https://foundryvtt.com/packages/wall-height),
  [Better Roofs](https://foundryvtt.com/packages/betterroofs). The floor, roof and wall tools work with them;
  the rest of the module does not need them.
- Optional: Mass Edit, Sequencer, Dice So Nice — only the tools that mention them use them.

## Installation

In Foundry: **Add-on Modules → Install Module**, search for **ADMaps Tools**, or paste the manifest URL:

```
https://github.com/ar2rfenix/admaps-tools/releases/latest/download/module.json
```

## Elevation regions

The region config gets a type selector:

- **Plateau** — a floor at a set elevation (a roof, a platform, an upper deck).
- **Stairs** — a ramp from the bottom to the top along the ascent direction, shown with arrows.
- **Water** — a token below the surface switches to Swim movement.
- **Transport** — a token inside ignores region effects; attach the region to a tile (a cart, a boat) with Mass Edit
  so it moves with it.

While moving, a token's elevation follows the floor under it: up the stairs, onto the plateau, down to the ground.
A token dropped while a Levels floor is selected lands on that floor at the drop point. The whole feature can be
switched off with the **Elevation regions** setting.

## Tools

### Scenes
- **Scene variations** — switch between prepared takes on the same map (time of day, layout) from the scene menu;
  variations are read from JSON files next to the map.
- **Import scenes from folder** — a button in the Scenes list: every scene export in a data folder and its subfolders
  is imported as a separate scene, exactly like a manual «Import Data».
- **Quick scene export** — saves the scene export straight into the folder with its background, no save dialog.
- **Scene export name** — exported files are named after the background map instead of `fvtt-Scene-…`.
- **Scene flip / rotate** — mirror a scene or rotate it 180° (background, tiles, walls, regions, lights, sounds, notes,
  drawings), with a reset to the original.
- **Scene recording** — records the canvas without the UI for a set time into a data folder.
- **Active adventure** — mark a scene folder, then «Copy and view» copies a template scene into it and opens the copy.
- **Scene background freeze** — freezes an animated background on the same frame for everyone.

### Tiles and roofs
- **Partial tile fade** — a new occlusion mode: on hover a roof dissolves only in front of doors and windows and where
  the token looks through them; a token that walks in to stop under the roof fades it whole at once. Optional outline,
  inner shadow and fog inside the cut.
- **Better Roofs link on hover** — linked tiles («Occlusion Link Id») also fade while the source tile is hovered.
- **Roof fog fix** — clears the stale black fog left after a token leaves a Better Roofs roof.
- **Roofs fade fast** — removes the core delay before a roof fades.
- **Tile control panel** — tiles listed by Z-order: isolate, zoom, search, reorder with Alt+↑/↓.
- **Tile auto-align** — puts a tile back where it sat on the original map by matching it against the background.
- **Tile scroll** — animated texture scrolling with feathered edges.
- **Video reanimator** — resumes WEBM videos on the canvas when they freeze.

### Doors and walls
- **Door swing preview** — shows which way a door opens, in the wall config and with Alt+W.
- **Invert door** — swaps a door's ends so it opens from the other end.
- **Quick door** — one click turns a wall into a wooden door with a sound, a swing animation and a texture.
- **Door under a token** — a door icon under a token stops stealing clicks from it.
- **Door leaf below the roof** — textured door leaves are drawn at their floor's height, so roofs cover them.
- **Wall chain by clicks** — draw walls point by point or trace them through grid intersections, then make a region
  from the outline.
- **Wall filter by floor** — shows only the walls of one floor while you edit.
- **Walls during movement use waypoint elevation** — height-limited walls are tested at the elevation of each waypoint
  (a stair step, a plateau).

### Multiple floors (Levels)
- **Floor follows token** — the Levels floor panel follows the selected token's elevation.
- **Other floors: ghosts** — for the GM, tokens on other floors fade instead of vanishing.
- **Effects on own floor** — Sequencer effects show only on the floor they were placed on.
- **Descend at path end** — a token leaving a roof keeps its elevation until the move ends, so it does not show through
  the floor below.
- **Disable Levels stairs** — turns off Levels stair regions, which conflict with elevation regions.

### Tokens
- **Token drop from folder** — drop an actor folder onto the scene and place its tokens as a group, wall-aware.
- **Auto token z-order** — smaller tokens render above larger ones.

### Teleports
- **Teleports on transfer** — «Teleport Token» destinations keep pointing at the right regions after a scene is
  duplicated, imported from JSON, or regions are pasted.
- **Paired region teleport** — creates a two-way teleport between two regions in one window.
- **Teleport: step back on refusal** — a token that declines a teleport returns to the last cell before the region
  instead of staying in the wall.

### Editing and files
- **File preview in picker** — hover to play sounds and preview images and videos; recursive search in subfolders.
- **Mass Edit mirroring** — fixes the ascent direction of mirrored plateaus and stairs.
- **Region from tile** — traces a plateau region from a tile's opacity.

### Module
- **Update notice** — when a newer ADMaps Tools release is out, the GM gets a window with both versions and how to
  update. «Don't show again» hides it until the next release.

## Languages

English, Russian.

## License

[MIT](LICENSE) © ADMaps
