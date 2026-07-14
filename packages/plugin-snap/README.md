# @fleximap/plugin-snap

Snapping for FlexiMap — vertex, intersection, midpoint, edge, extension, perpendicular and grid.

## Snapping is middleware, not a service

This is the whole design, and it is worth one paragraph before the API.

The snap engine registers **one interaction middleware, at priority 100**. On every
pointer event it queries its providers, picks a winner, sets `ctx.snap`, and
**rewrites `ctx.lngLat`** — before the pipeline reaches any tool.

So the draw plugin does not import this package. It has never heard of it. It reads a
pointer position that has _already_ been snapped to the parcel corner, by middleware
it knows nothing about, installed by a preset it knows nothing about. The same is
true of the measure tool, the edit tool, and a tool a stranger writes next year: they
all get snapping for free, and none of them contains a line of snapping code.

If you find yourself wanting a function from this package to call from a tool, the
architecture is telling you something.

## Install

```ts
import { createFlexiMap } from '@fleximap/core'
import { snapPlugin } from '@fleximap/plugin-snap'
import { drawPlugin } from '@fleximap/plugin-draw'

const map = await createFlexiMap({
  container: '#map',
  plugins: [
    snapPlugin({ tolerance: 12, gridSize: 5 }),
    drawPlugin(), // knows nothing about snapping, and snaps anyway
  ],
})

map.events.on('snap:changed', (e) => {
  status.textContent = e.payload.result?.candidate.hint ?? ''
})
```

Hold **Alt** to suppress snapping for one event — the universal CAD convention, and
what users reach for when they need a point _near_ a corner rather than _on_ it.

## What it registers

| Extension point         | What                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Interaction middleware  | one, id `snap`, priority 100 — rewrites `ctx.lngLat` and sets `ctx.snap`                                                       |
| Renderer source + layer | `snap:indicator` — the mark under the cursor, styled from `theme.token('color').snapIndicator` and `size.snapIndicatorRadius`  |
| i18n                    | `snap.vertex`, `snap.edge`, `snap.midpoint`, `snap.intersection`, `snap.extension`, `snap.perpendicular`, `snap.grid` (en, tr) |
| Plugin registry         | `map.plugin('snap') → SnapApi`, no cast                                                                                        |
| Capability              | `provides: ['snap-engine']` — swap the whole engine without touching dependents                                                |

Everything above goes through `ctx.disposables`, so removing the plugin removes all
of it (there is a test).

**It never writes to the feature store, and dispatches no commands.** Its state — the
current snap, the exclusion set, the in-progress ring — is ephemeral; there is
nothing here to undo, and an undo entry for "the mouse moved" would be a bug. The
indicator therefore lives in its own _renderer_ source rather than in a store
collection: a decoration in the store would show up in `store.snapshot()`, which is
what every undo round-trip test in the repo compares for deep equality, and every
plugin's undo test would then pass or fail depending on where the mouse was.

## Dependencies

None. Not on other plugins, not optionally. `@fleximap/core` is a peer dependency.

## Events

```ts
declare module '@fleximap/core' {
  interface FlexiEventMap {
    'snap:changed': { readonly result: SnapResult | undefined }
  }
}
```

Fires only when the result actually _changes_ — including to `undefined`, when the
pointer leaves everything snappable. A status bar bound to it does not repaint 120
times a second while the cursor rests on a corner.

## Options

```ts
snapPlugin({
  tolerance: 10,        // screen pixels. How close is "close". Default 10.
  providers: [...],     // which built-ins to install. Default: all of them except grid.
  gridSize: 5,          // metres, in the WORKING CRS. Required for the grid provider.
  enabled: true,        // start snapping on. Default true.
})
```

## The built-in providers, and why the priorities are what they are

| Kind            | Priority | Snaps to                                                                                                                         |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `vertex`        | 100      | any feature corner — **and the vertices of the ring being drawn**, which is how a user closes a ring by clicking its first point |
| `intersection`  | 90       | where two edges properly cross                                                                                                   |
| `midpoint`      | 80       | the middle of an edge                                                                                                            |
| `edge`          | 70       | the perpendicular foot on an edge                                                                                                |
| `extension`     | 50       | the infinite continuation of an edge, past its endpoint                                                                          |
| `perpendicular` | 50       | the point making a 90° angle from the last in-progress vertex to a nearby edge                                                   |
| `grid`          | 10       | a regular grid of `gridSize` metres in the working CRS                                                                           |

**The ordering is load-bearing.** A vertex must outrank the edge it sits on: when the
pointer is near a corner, the perpendicular foot on the edge _through_ that corner is
at exactly the same distance, to the last bit. Sort by distance first and snapping to
a corner becomes a coin flip — which users experience as the software being broken in
a way they cannot describe. Priority first, distance second.

Grid sits at the floor for the mirror-image reason: a grid candidate exists
_everywhere_, so if it outranked anything real you could never snap to a corner that
was not itself drawn on the grid — which is every corner in every dataset you did not
create.

## Geometry

Every construction — the perpendicular foot, the midpoint, the crossing, the grid
cell — is computed in the **projected working CRS, in metres** (core invariant 3, and
the `gis-geometry-precision` skill). The same maths on lng/lat is not merely
imprecise, it is wrong in a specific direction: a degree of longitude at Ankara is
~85 km against ~111 km for a degree of latitude, so an un-projected perpendicular
foot is pulled along the parallel by a factor of 1.3, landing ~30 cm off a 50 m
boundary. It renders perfectly.

A **vertex** candidate is the exception, and deliberately so: it returns the store's
coordinate _verbatim_, never a `inverse(forward(p))` round trip. The round trip is
accurate to nanometres, and nanometres are precisely the problem — two parcels share a
corner as the _same bits_, the topology index keys on it, and a snap returning a value
one ULP away would place the new vertex beside the shared corner rather than on it.
That is how a sliver is born.

Providers hit the store's R-tree (`Collection.query(bbox)`) and never linear-scan. The
tolerance bbox comes from the four corners of the tolerance square _in screen space_,
un-projected — correct under a rotated camera and at high latitude, where a
degrees-per-pixel guess is not.

## Adding your own snap targets

This is the extension point, and it is the reason the engine is open-ended. A cadastre
plugin snaps to a _parcel corner_ specifically; a utilities plugin to a pipe junction;
a game plugin to a hex centre. Implement `SnapProvider`, register it, and **every tool
in the product** — including tools you did not write — snaps to your targets.

```ts
const handle = map.plugin('snap').addProvider({
  id: 'cadastre:parcel-corner', // namespace it; ids must be unique
  priority: 110, // above a plain vertex: a *registered* corner beats a drawn one
  query(point, tolerancePx, ctx) {
    // ctx.bbox is the tolerance circle, precomputed — use it to hit the spatial index.
    // ctx.exclude is what must not snap to itself. ctx.inProgress is the current ring.
    return corners.query(ctx.bbox).map((corner) => ({
      kind: 'parcel-corner',
      point: corner.point,
      distancePx: distance(ctx.project(point), ctx.project(corner.point)),
      priority: 110,
      hint: i18n.t('cadastre.snap.corner'),
    }))
  },
})

ctx.disposables.add(handle) // invariant 5
```

`query()` runs on every pointer move, up to 120 Hz. Query an index; do not scan. A
provider that throws is logged and skipped for that event — a degraded map beats a
dead cursor — but do not rely on that.

## Gesture-scoped API

Two things only the plugin driving a gesture can know, so it must tell the engine:

```ts
const snap = ctx.tryPlugin('snap') // optional dependency: guard, never assume

// The feature being dragged must not snap to itself — the vertex under the cursor
// *is* the vertex you are moving, at distance zero, and it wins every time.
snap?.exclude([feature.id])

// The ring so far. Lets the user close it on its own first vertex, and gives the
// perpendicular provider something to be perpendicular *from*.
snap?.setInProgress(ring)
```
