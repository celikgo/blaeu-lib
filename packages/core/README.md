# @blaeu/core

The Blaeu kernel: an event bus, a plugin registry, two middleware pipelines, a command bus,
and a feature store — plus the small set of services every plugin needs to share: CRS,
layers, theme, tools, i18n and validation. Nothing domain-specific.

```
npm install @blaeu/core maplibre-gl
```

> Not on npm yet — see [the root README](../../README.md#packages) for how to run it from source.

```ts
import { createBlaeuMap } from '@blaeu/core'
import { snapPlugin } from '@blaeu/plugin-snap'
import { drawPlugin } from '@blaeu/plugin-draw'
import { historyPlugin } from '@blaeu/plugin-history'

const map = await createBlaeuMap({
  container: '#map',
  crs: { working: 'EPSG:5254', display: 'projected', precision: 3 }, // TUREF/TM30, mm
  plugins: [snapPlugin({ tolerance: 12 }), drawPlugin({ collection: 'parcels' }), historyPlugin()],
})

map.tools.activate('draw:polygon')
map.events.on('draw:complete', (e) => {
  console.log(map.i18n.area(map.crs.area(e.payload.feature.geometry))) // planar m²
})
```

Ten lines, and the polygon you draw already snaps to the corners of every parcel on the map,
is quantised to the millimetre grid of EPSG:5254, and is undoable with Ctrl+Z. The draw plugin
is responsible for none of that.

## What the core owns

| Service                    | What it is                                                                        |
| -------------------------- | --------------------------------------------------------------------------------- |
| `map.events`               | Typed event bus, with cancellable `before:` hooks                                 |
| `map.plugins`              | Plugin registry: install, enable, disable, dependency resolution                  |
| `map.interaction`          | The **synchronous** pipeline. Runs on every pointer event; snapping lives here    |
| `map.commit`               | The **asynchronous** pipeline. Runs on every durable write; validation lives here |
| `map.commands`             | Command bus. `dispatch()` for transient, `commit()` for durable                   |
| `map.store`                | The feature store, with spatial and topology indexes                              |
| `map.crs`                  | Projection, quantisation, planar area and length                                  |
| `map.layers` / `map.theme` | Layer definitions and the theme they resolve against                              |
| `map.tools`                | Tool registry and the active tool                                                 |
| `map.i18n`                 | Messages, number and unit formatting                                              |
| `map.validation`           | Rule registry, consulted by the commit pipeline                                   |

Everything else — drawing, snapping, editing, measurement, selection, undo/redo, topology,
even layer _types_ — is a plugin registering through an extension point the core owns. The
kernel has never heard of a parcel, and it never will.

## API

Alongside the services above, the map handle itself is small enough to list in full:

| Member                                    | What                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `map.plugin(id)` / `map.tryPlugin(id)`    | typed handle to a plugin's API, no cast; `tryPlugin` returns `undefined` rather than throwing |
| `map.use(plugin, options)`                | install a plugin at runtime — the same path a preset takes                                    |
| `map.remove(id)`                          | remove one, disposing everything it registered                                                |
| `map.whenReady()`                         | resolves once the renderer has mounted and every plugin's `setup` has completed               |
| `map.destroy()`                           | teardown; `await` it, because plugin teardown is asynchronous                                 |
| `map.renderer` / `map.config` / `map.log` | the renderer in use, the fully-resolved config, the plugin-prefixed logger                    |
| `map.debug.snapshot()`                    | listener, middleware, layer, plugin and feature counts                                        |

`map.plugin('snap')` is the typed accessor the whole plugin ecosystem is reached through:
a plugin augments `BlaeuPluginRegistry` with its own id, so the return type is its API and
not `unknown`. `map.debug.snapshot()` is what the teardown test in every plugin compares
before and after a `remove()` — a count that has not returned to its starting value is a
leak, stated as a number rather than as a hunch.

## Configuration

`createBlaeuMap` takes one object, and every field but `container` is optional. The
defaults are chosen to be wrong _nowhere in particular_ rather than right somewhere:

| Option        | Default                                                      | Note                                                                    |
| ------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `container`   | —                                                            | an element or a selector; the only required field                       |
| `preset`      | none                                                         | a domain bundle; anything set alongside it overrides it                 |
| `plugins`     | `[]`                                                         | installed after the preset's                                            |
| `crs`         | `{ working: 'EPSG:3857', display: 'decimal', precision: 3 }` | Web Mercator, decimal readouts, millimetres. Every preset overrides it  |
| `camera`      | `{ center: [0, 0], zoom: 2, bearing: 0, pitch: 0 }`          |                                                                         |
| `layers`      | `[]`                                                         | layer specs, resolved against the theme                                 |
| `theme`       | the default theme                                            | a full theme or a deep partial of one                                   |
| `locale`      | `'en'`                                                       |                                                                         |
| `renderer`    | `new MapLibreRenderer()`                                     | the seam; see below                                                     |
| `interaction` | `dragThreshold: 3`, everything else on                       | three pixels, because below that a trackpad "click" is a one-pixel drag |
| `strict`      | on outside production                                        | freezes store reads and asserts invariants                              |
| `logger`      | derived from `strict`                                        |                                                                         |

`strict` is the one worth a sentence: it is on by default in development precisely so the
invariant you are about to violate fails loudly on your machine rather than quietly on a
surveyor's.

## Presets

A preset is a first-class core concept and it is **plain data** — plugins, config, layers,
validation rules, theme and messages in one object, passed as `createBlaeuMap({ preset })`.
Core exports `definePreset` to build one, `composePresets` to combine several, and
`overridePreset` to adjust one without forking it. Config precedence runs defaults →
preset → options, which is why a municipality can adopt a national cadastre preset and
still bump the coordinate precision without owning a copy of it.

The kernel itself has no opinion about what is in a preset. That is the point: judgement
lives in the preset tier, capability in the plugin tier, and neither leaks into the core.

## The two pipelines

The distinction is the one thing to internalise, and it is enforced rather than encouraged:

- **Interaction is synchronous.** It runs on `pointermove`, up to 120 times a second. An
  `await` in here is a dropped frame. Snapping is middleware at priority 100: it rewrites
  `ctx.lngLat` before any tool sees it.
- **A commit is asynchronous.** Validation may consult a server. `commands.commit()` runs the
  pipeline and applies the command in one call; `dispatch()` refuses a `CommitCommand` at
  compile time _and_ at runtime.

The rule of thumb: **if it survives the gesture, it commits.**

## The renderer seam

`Renderer` is an interface, and MapLibre is one implementation of it. That is what lets the
whole library run headless in tests against `FakeRenderer`, with no GPU.

Pass your own with `createBlaeuMap({ renderer })`. Core exports `MapLibreRenderer` and
`MapLibreRendererOptions` as the default implementation — along with `blankStyle` and the
`ID_PROPERTY` / `LOCKED_PROPERTY` / `HIDDEN_PROPERTY` keys it writes into rendered
features — and `@blaeu/core/testing` exports `FakeRenderer` as the other one.

```ts
import { createTestMap } from '@blaeu/core/testing'
import { drawPlugin } from '@blaeu/plugin-draw'

const map = await createTestMap({ plugins: [drawPlugin()] })
map.test.click([32.85, 39.93])
await map.test.flush()
```

`@blaeu/core/testing` is a published entry point and imports no test framework, so it works
under Vitest, Jest, or none of them. It carries more than `createTestMap`: `FakeRenderer`
itself, the geometry fixtures (`ANKARA`, `parcelFixture`, `sharedEdgeParcels`,
`sliverParcels`, `gridOfParcels`, `selfIntersectingRing`, `duplicateVertexRing`,
`offsetMetres`, `distanceMetres`), and the metric matchers `expectWithinMetres` /
`withinMetres`, which assert a distance in metres rather than in float noise.

`map.test` drives the map the way a user does — `pointerMove`, `pointerDown`, `pointerUp`,
`click`, `dblClick`, `key`, `drag`, `camera`, `seed` — in geographic coordinates, through
the renderer's `project()` and into the real interaction pipeline, which is what makes
pixel-denominated middleware behave as it does in a browser. The `await map.test.flush()`
above is not decoration: the commit pipeline is asynchronous, so anything that went
through validation has not landed until you await it.

## Coordinates

Two rules, implemented once, on ingest:

1. **Precision is reduced once**, to the working CRS's grid. Everything downstream may then
   compare coordinates exactly.
2. **Rings are wound RFC 7946 and closed.** A wrongly-wound hole becomes a second exterior
   ring, and the parcel's area is then the _sum_ rather than the difference. That number goes
   on a deed.

Area and length are **planar, in the working CRS** — never spherical, and never in degrees. A
land registry rejects a spherical area.

## Peer dependency

`maplibre-gl` is a peer, not a dependency: two copies of MapLibre in one page is two WebGL
contexts and a map that half-works. The supported range is `>=4.7.0 <7` — v4, v5 and v6 all
satisfy the seam, and there is a test that says so rather than a note that hopes so
(`src/renderers/peer-range.test.ts`). The same rule applies one tier up — `@blaeu/core` is a
peer dependency of every plugin, never a dependency, because two copies of the kernel is two
event buses and a listener that silently never fires.

Core's only true runtime dependencies are `proj4` and `rbush`: the projection maths and the
R-tree behind the spatial index. Neither has an alternative that is smaller and still
correct.

ESM only. See [ADR 0008](../../docs/adr/0008-maplibre-with-a-renderer-seam.md) for the
renderer seam, and the [architecture guide](../../ARCHITECTURE.md) for the rest.

## Licence

MIT
