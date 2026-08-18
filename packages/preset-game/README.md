# @blaeu/preset-game

The Blaeu kernel, aimed at a level editor.

```ts
import { createBlaeuMap } from '@blaeu/core'
import { gameMapPreset } from '@blaeu/preset-game'

const map = await createBlaeuMap({
  container: '#map',
  preset: gameMapPreset({ gridSize: 32, gridType: 'square' }),
})
```

That is the whole setup. You get a flat world in arbitrary units, a drawn tile grid, snapping
to tile centres, entity placement, zone drawing, selection, undo/redo and a toolbar — with no
geodesy, no basemap, and no cadastral topology anywhere in the bundle.

## Why this package exists

It exists to falsify the obvious objection to Blaeu: that a "geospatial kernel" is really a GIS
library with a plugin API bolted on.

A game world has no Earth. If the core had assumed one, this preset would be impossible without
forking it. It isn't, because of three seams the core deliberately left open:

- **`crs.register()`** — the world is a plane in arbitrary units, registered as a custom CRS.
  Every planar facility in the kernel then works on it unchanged, because none of them were
  written against the Earth; they were written against `crs.working`.
- **`layers.registerType()`** — `tile-grid` is a rendering category the core has never heard
  of, added here in one file.
- **The commit pipeline** — procedural generation runs as commit middleware, the same seam
  `@blaeu/preset-cadastre` uses for topology validation. The kernel does not know that one
  spawns decorations and the other prevents a lawsuit.

And one thing it deliberately does _not_ install: `@blaeu/plugin-topology`. A level has no
parcels, so the preset omits it, and the bundle does not carry JSTS. That is only possible
because topology is a plugin rather than a core feature.

## Options

| Option          | Default                      | Notes                                                       |
| --------------- | ---------------------------- | ----------------------------------------------------------- |
| `gridSize`      | `32`                         | Tile size in **world units**, not metres                    |
| `gridType`      | `'square'`                   | `'hex'` swaps the drawn lattice _and_ the snap provider     |
| `entities`      | a starter set                | What can be placed; see `DEFAULT_ENTITIES`                  |
| `bounds`        | `[-2048, -2048, 2048, 2048]` | The playable rectangle, in world units                      |
| `collection`    | `'entities'`                 | Where placements land unless the entity type says otherwise |
| `snapTolerance` | `16`                         | Screen pixels — a tile is a big target, so aim can be loose |
| `historyLimit`  | `50`                         | A level editor's undo is shallow; a deep one costs memory   |
| `generators`    | none                         | Procedural generators; `onGenerate()` adds more at runtime  |
| `locale`        | `'en'`                       | `'tr'` ships too                                            |

## Hex worlds

`gridType: 'hex'` is not only a different drawing. The preset installs **no built-in grid snap
provider** on a hex world, because `tileGridPlugin` registers a `hex-centre` provider at the
same priority — and with both live, the snap engine breaks the priority tie by distance, so the
square lattice would routinely win and place entities off-centre.

## The world plane

`unitsPerDegree` (default 100 000) is the one number that trades world **extent** against
coordinate **precision**. You are unlikely to want to change it, but it is an option because
only you know which your game needs. `assertWorldFits()` will tell you when your `bounds` no
longer survive the round trip.

## Licence

MIT
