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
to tile corners — hex centres on a hex world — entity placement, zone drawing, selection,
undo/redo and a toolbar, with no geodesy, no basemap, and no cadastral topology anywhere in
the bundle.

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

Twenty-five, grouped the way the source groups them. The test for whether something belongs
here is preset rule 3: if you would have to copy `preset.ts` into your project to change it, it
should have been an option.

### The world

| Option     | Default                      | Notes                                                   |
| ---------- | ---------------------------- | ------------------------------------------------------- |
| `gridSize` | `32`                         | Tile size in **world units**, not metres                |
| `gridType` | `'square'`                   | `'hex'` swaps the drawn lattice _and_ the snap provider |
| `entities` | a starter set                | What can be placed; see `DEFAULT_ENTITIES`              |
| `bounds`   | `[-2048, -2048, 2048, 2048]` | The playable rectangle, in world units                  |
| `locale`   | `'en'`                       | `'tr'` ships too                                        |

### Placement

| Option          | Default      | Notes                                                       |
| --------------- | ------------ | ----------------------------------------------------------- |
| `collection`    | `'entities'` | Where placements land unless the entity type says otherwise |
| `snapTolerance` | `16`         | Screen pixels — a tile is a big target, so aim can be loose |
| `historyLimit`  | `50`         | A level editor's undo is shallow; a deep one costs memory   |
| `generators`    | `[]`         | Procedural generators; `onGenerate()` adds more at runtime  |

### The world plane

| Option           | Default        | Notes                                                                       |
| ---------------- | -------------- | --------------------------------------------------------------------------- |
| `unitsPerDegree` | `100_000`      | World units per degree of lng/lat. See "How the CRS trick works" below.     |
| `crsCode`        | `'GAME:WORLD'` | The code the plane registers under. Deliberately not an EPSG number.        |
| `precision`      | `0.001`        | Quantisation **grid**, in world units — a millitile, not a count of digits. |

### Look

| Option            | Default     | Notes                                                                       |
| ----------------- | ----------- | --------------------------------------------------------------------------- |
| `backgroundColor` | `'#0f1216'` | The whole basemap. A flat colour, because in a game the _world_ is the map. |
| `gridColor`       | `'#2b3440'` | Grid line colour.                                                           |
| `gridOpacity`     | `0.9`       | Grid line opacity.                                                          |
| `gridLineWidth`   | `1`         | Grid line width, in pixels.                                                 |
| `majorEvery`      | `8`         | Every Nth line is drawn heavier. `0` disables major lines.                  |
| `maxGridCells`    | `4096`      | A guard, not a preference — see below.                                      |

`maxGridCells` is the one in that group that is not cosmetic. `bounds: [-1e6, -1e6, 1e6, 1e6]`
with `gridSize: 1` is four million line features, and the honest failure is an error naming both
numbers rather than a tab that stops responding.

### Rules

| Option              | Default     | Notes                                                                  |
| ------------------- | ----------- | ---------------------------------------------------------------------- |
| `boundsSeverity`    | `'error'`   | Placing outside `bounds`. Off the map is off the map.                  |
| `occupancySeverity` | `'warning'` | Two entities on one tile. `'error'` blocks it; `'off'` drops the rule. |

### Optional plugins

| Option           | Default     | Notes                                                             |
| ---------------- | ----------- | ----------------------------------------------------------------- |
| `ui`             | `true`      | Mount the framework-free chrome (toolbar, readout, undo buttons). |
| `attributions`   | `[]`        | Handed to the `ui` plugin's attribution line.                     |
| `zones`          | `true`      | Polygon drawing for terrain zones (water, forest, spawn area).    |
| `zoneCollection` | `'zones'`   | Where drawn zones land.                                           |
| `zoneColor`      | `'#38bdf8'` | Fill and outline colour for drawn zones.                          |

## Hex worlds

`gridType: 'hex'` is not only a different drawing. The preset installs **no built-in grid snap
provider** on a hex world, because `tileGridPlugin` registers a `hex-centre` provider at the
same priority — and with both live, the snap engine breaks the priority tie by distance, so the
square lattice would routinely win and place entities off-centre.

## The plugins it ships

Three, all with typed APIs — `map.plugin('game-world')` needs no cast, because each plugin
augments the registry.

```ts
const world = map.plugin('game-world')
world.code // 'GAME:WORLD'
world.bounds // the WorldBbox, in world units
world.gridSize // 32
world.gridType // 'square' | 'hex'
world.contains(xy) // is this position inside the world?
world.snap(xy) // nearest square cell corner, or hex centre
world.toWorld(lngLat) // lng/lat → world units
world.toLngLat(xy) // world units → lng/lat
world.boundsToLngLat(bounds) // a WorldBbox → a 4326 bbox, e.g. for renderer.fitBounds()

const entities = map.plugin('game-entity')
entities.types // the EntityType list
entities.current // the type the place tool will drop next, or null
entities.setCurrent('tree') // throws on an unknown id — a typo would otherwise place nothing
await entities.place([128, 96], 'tree') // same commit pipeline as a click; resolves to what was written
entities.onGenerate(fn) // a Disposable — dispose it (core invariant 5)
```

`game-entity` also registers the place tool, `PLACE_TOOL = 'entity:place'`, activated the usual
way with `map.tools.activate(PLACE_TOOL)`. `place()` is the same path a click takes — same
generators, same validation, same single undo step — which is what makes a level importer and a
level designer indistinguishable to the rest of the system.

`game-grid` registers the `tile-grid` layer **type** and its `TileGridConfig` (`gridSize`,
`gridType`, `bounds`, `color`, `opacity`, `lineWidth`, `majorEvery`, `maxGridCells`, all
defaulting to the plugin's own options). A second grid at a coarser spacing — a "chunk" overlay
— is therefore one more layer object, not a fork. On a hex world it also registers the
`hex-centre` snap provider.

Procedural generation is a plain function of the world:

```ts
import { gameMapPreset, scatterAround } from '@blaeu/preset-game'

gameMapPreset({
  generators: [scatterAround({ type: 'tree', count: 4, radius: 24, around: ['hut'] })],
})
```

Placing one hut writes five features and **one** undo step, because the generated features are
committed in the same command as the entity that triggered them. The hex helpers
(`hexCentre`, `hexRing`, `hexCentresIn`, `nearestHexCentre`, `hexCircumradius`,
`hexRowSpacing`) are exported too, for a product that wants to reason about the lattice itself.

## Layers, collections and properties

| layer id                     | source           | notes                                             |
| ---------------------------- | ---------------- | ------------------------------------------------- |
| `game-grid`                  | —                | The `tile-grid` type this preset registers itself |
| `game-zones`                 | `zoneCollection` | Present only when `zones: true`                   |
| `game-entities-<collection>` | that collection  | One per collection the entity set writes to       |

Bottom to top: grid, zones, entities. Entities go last so a placed tree is clickable over the
zone beneath it — layer order is paint order, and a level designer who cannot select the thing
they can see will, rightly, file it as a bug. Most levels have exactly one entity layer; an
`EntityType` that sets `layer:` gets its own, which is how a spawn marker stays above the rocks.

Two properties are stamped on the features themselves, and both are exported:

- **`$entity`** (`ENTITY_PROPERTY`) — the `EntityType` id. It is what the icon `match`
  expression reads, which is why entity ids must be unique and why the preset throws if they
  are not.
- **`$generated`** (`GENERATED_PROPERTY`) — set on anything a generator produced, so generators
  cannot re-trigger on their own output and the occupancy rule cannot have a decoration veto the
  placement that spawned it.

## Rules

Two, and the contrast with a cadastre's is the point: no self-intersection, no overlap with
neighbours, no minimum area — identical machinery, opposite judgement.

| id                         | option              | default     | what it does                                     |
| -------------------------- | ------------------- | ----------- | ------------------------------------------------ |
| `game.entity.inBounds`     | `boundsSeverity`    | `'error'`   | Placement outside `bounds` is **not written**    |
| `game.entity.tileOccupied` | `occupancySeverity` | `'warning'` | Two entities on one tile — reported, not blocked |

Out of bounds is an `error` on purpose. A game engine that loads a level and finds an entity at
(−9000, 12) does not show a warning; it indexes outside its chunk array and crashes on someone
else's machine. The issue carries the coordinates and the bounds in world units, because an
issue that says "out of bounds" and makes you work out where is an issue that gets ignored.

Occupancy is a `warning` because stacking a torch on a crate is normal, and a rule that blocked
it would make the editor feel broken. Generated features are exempt. A tower-defence game where
a tile holds exactly one tower sets `occupancySeverity: 'error'` and gets the block for free;
`'off'` removes the rule entirely rather than downgrading it. Both ids are exported
(`RULE_IN_BOUNDS`, `RULE_TILE_OCCUPIED`), so `overridePreset` and `validation.remove()` can name
them.

## The world plane

`unitsPerDegree` (default 100 000) is the one number that trades world **extent** against
coordinate **precision**. You are unlikely to want to change it, but it is an option because
only you know which your game needs. `worldCrsSpec()` calls
`assertWorldFits(bounds, createWorldTransform(unitsPerDegree))` for you, so a world too large
for its scale throws at construction with the `unitsPerDegree` that would fit — it refuses any
world whose corners fall outside ±60° of lng/lat, where the plane stops being well-conditioned.

## How the CRS trick works

A game world has no Earth. But Blaeu's store is WGS84 lng/lat without exception (core invariant
3), and that invariant is not negotiable: it is what lets the spatial index, the topology index,
GeoJSON export and every plugin ever written agree on what a coordinate _is_. So the preset does
not fight it. It registers a projected CRS whose plane **is** the game world, and lets the
kernel's existing projection sandwich do the rest — everything survey-grade in Blaeu (area,
length, distance, quantisation, grid snapping) already runs as
`working.forward → planar maths → working.inverse`, so making `working` the game plane makes all
of it work unchanged, in world units. `crs.area()` returns tiles².

The projection is `+proj=eqc` (equidistant cylindrical) on a sphere of our own choosing:

```
x = R · λ,  y = R · φ        (λ, φ in radians, lat_ts = 0)
```

which is exactly linear in degrees. Choose `R = unitsPerDegree · 180/π` and the map from degrees
to world units collapses to a pure scale — `x = unitsPerDegree · lng`, `y = unitsPerDegree · lat`
— with no trigonometry, no distortion and no latitude-dependent scale factor, because there is
no Earth. It is an affine identity plane wearing a proj4 string, which is the only disguise the
CRS abstraction requires.

Three limits, honestly:

1. **The world lives in a tiny patch of the equator.** At the default scale a 4096-unit world
   occupies 0.04° square near [0, 0]. That is deliberate — small and equatorial, so a `double`
   degree resolves about 1e-10 world units and nothing ever approaches the ±90° latitude where
   the inverse breaks. `assertWorldFits` refuses a world that does not.
2. **The lng/lat are meaningless as geography.** A tree at world (128, 96) is "at" 0.00128°E,
   0.00096°N — in the Gulf of Guinea. It is not there. Nothing in the game reads those numbers,
   and no basemap is drawn under them. Export through `toWorld`, never as raw GeoJSON, or your
   level file is a lie that happens to validate.
3. **It is not a real CRS and must not be published as one.** The code is `GAME:WORLD`, not an
   EPSG number, precisely so nobody can mistake it for one.

## Licence

MIT
