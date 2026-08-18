# @blaeu/core

The Blaeu kernel: an event bus, a plugin registry, two middleware pipelines, a command bus,
and a feature store. Nothing else.

```
npm install @blaeu/core maplibre-gl
```

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
whole library run headless in tests against `FakeRenderer`, with no GPU:

```ts
import { createTestMap } from '@blaeu/core/testing'
import { drawPlugin } from '@blaeu/plugin-draw'

const map = await createTestMap({ plugins: [drawPlugin()] })
map.test.click([32.85, 39.93])
```

`@blaeu/core/testing` is a published entry point and imports no test framework, so it works
under Vitest, Jest, or none of them.

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
contexts and a map that half-works. The same rule applies one tier up — `@blaeu/core` is a
peer dependency of every plugin, never a dependency, because two copies of the kernel is two
event buses and a listener that silently never fires.

ESM only. See [ADR 0008](../../docs/adr/0008-maplibre-with-a-renderer-seam.md) for the
renderer seam, and the [architecture guide](../../ARCHITECTURE.md) for the rest.

## Licence

MIT
