# @blaeu/plugin-snap

Snapping for Blaeu — vertex, intersection, midpoint, edge, extension, perpendicular and grid.

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

```
npm install @blaeu/plugin-snap @blaeu/core maplibre-gl
```

> Not on npm yet — see [the root README](../../README.md#packages) for how to run it from source.

```ts
import { createBlaeuMap } from '@blaeu/core'
import { snapPlugin } from '@blaeu/plugin-snap'
import { drawPlugin } from '@blaeu/plugin-draw'

const map = await createBlaeuMap({
  container: '#map',
  plugins: [
    snapPlugin({ tolerance: 12, gridSize: 5 }),
    drawPlugin(), // knows nothing about snapping, and snaps anyway
  ],
})

const readout = document.querySelector('#snap-readout')!

map.events.on('snap:changed', (e) => {
  readout.textContent = e.payload.result?.candidate.hint ?? ''
})
```

Hold **Alt** to suppress snapping for one event — the universal CAD convention, and
what users reach for when they need a point _near_ a corner rather than _on_ it. A
`keydown` never snaps either, so a keyboard shortcut fired mid-gesture does not leave a
stale indicator behind.

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

It _reads_ the store, and three filters decide what is a target at all. A feature is
skipped when `meta.hidden === true` or when `meta.snappable === false` — the latter is
how UI scaffolding stays out of the auction, because a vertex handle sits exactly on the
vertex it represents, and without the flag the pointer snaps onto the handle of the very
vertex being dragged and pins it there. `snappable` is a kernel field defaulting to
`true`, which is what lets plugin-edit keep its handles un-snappable without the snap
plugin having heard of plugin-edit. The `snap:indicator` source is never a target either;
the mark under the cursor snapping to itself would be its own kind of comedy.

## Dependencies

None. Not on other plugins, not optionally. `@blaeu/core` is a peer dependency.

## Events

```ts
declare module '@blaeu/core' {
  interface BlaeuEventMap {
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
  // screen pixels. How close is "close". Default 10. Must be > 0; throws otherwise —
  // use { enabled: false } to turn snapping off.
  tolerance: 10,
  // which built-ins to install. Default: vertex, intersection, midpoint, edge,
  // extension and perpendicular — plus grid, but only when gridSize is set.
  providers: [...],
  // metres, in the WORKING CRS. Required for the grid provider. Must be > 0 when
  // present; omit it entirely to install no grid provider.
  gridSize: 5,
  // start snapping on. Default true.
  enabled: true,
})
```

## API

`map.plugin('snap')` returns `SnapApi`, typed and cast-free:

| Member                                      | What                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `addProvider(provider): Disposable`         | register a source of targets; every tool snaps to them from the next move     |
| `removeProvider(id)`                        | drop one by id                                                                |
| `providers(): readonly SnapProvider[]`      | what is currently registered, built-ins included                              |
| `setTolerance(px)`                          | change the radius at runtime; throws on a non-positive value                  |
| `readonly current: SnapResult \| undefined` | what the last pointer event snapped to, without subscribing to `snap:changed` |
| `enable()` / `disable()`                    | the runtime toggle the `enabled` option only sets the initial value of        |
| `exclude(ids)`                              | features to ignore; replaces the previous set                                 |
| `setInProgress(points)`                     | the vertices committed so far in the current gesture                          |

The last two are gesture-scoped and have a section of their own below.

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

You do not have to hand-roll the maths. The package exports the same toolkit the
built-ins are written against, and using it is how a third-party provider inherits the
precision rules rather than re-deriving them:

- `createScope(deps, point, tolerancePx, ctx)` gives you `scope.plane` — the projected
  working CRS every construction must happen in — along with `scope.distancePx()` and
  `scope.searchMetres`, the tolerance converted into metres by _measuring_ the local
  scale at the cursor rather than assuming it.
- `candidateAt(scope, kind, xy)` and `candidateAtLngLat(scope, kind, point)` build a
  tolerance-filtered `SnapCandidate`, returning `undefined` rather than a candidate the
  engine would discard. `candidateAtLngLat` is what enforces the verbatim-coordinate rule
  above: pass a store coordinate through it and the bits come back untouched.
- `PRIORITY` is the priority table, so you can slot yours against the built-ins by name
  instead of by a magic number that drifts.

Also exported, for the same reason: the geometry primitives `footOnLine`, `footOnSegment`,
`segmentIntersection`, `segmentsNear`, `segmentsWhoseLineIsNear`, `eachPath` and
`FrameCache`; the seven provider factories `createVertexProvider` … `createGridProvider`,
should you want to install one by hand; the constants `BUILTIN_KINDS`,
`DEFAULT_TOLERANCE_PX`, `INDICATOR_SOURCE` and `INDICATOR_LAYER`; and the types `SnapApi`,
`SnapOptions`, `SnapDeps` and `SnapScope`.

## Gesture-scoped API

Some things only the plugin driving a gesture can know. The most common one — what is
being dragged — is **not** in this API, and deliberately so.

### Dragging: tell the kernel, not the snap engine

A dragged feature must not snap to itself: the vertex under the cursor _is_ the vertex you
are moving, it is at distance zero, and it wins every time, which pins it in place and
turns every drag shorter than the tolerance into a silent no-op. The fix is one line, on
the kernel:

```ts
ctx.tools.setDragging([feature.id]) // and setDragging([]) when the gesture ends
```

The snap engine reads `ctx.dragging` off the interaction context and unions it into its
own exclusion set. No call into this package, no optional dependency, no guard — a tool
states a fact about itself and any middleware that cares can act on it, snapping today and
a grid lock or a constraint solver tomorrow. This is [ADR 0010](../../docs/adr/0010-tools-declare-what-they-drag.md),
which exists precisely to remove the out-of-band plugin-to-plugin channel that
`exclude()` used to be for this case. The edit plugin — the one that actually drags
geometry — never mentions snapping at all.

### `exclude()`: for what is in the store but is not being dragged

That leaves a narrower job. A transient preview — a rubber band, a half-closed ring — is a
real feature in the store, so it is a snap target, but no tool is _dragging_ it. The draw
plugin is the working example: it excludes its own preview so the rubber band cannot snap
to itself.

```ts
// Plugins may not import one another, so `@blaeu/plugin-snap`'s registry augmentation is
// not in scope here and 'snap' is not a key `ctx.tryPlugin` will accept. Go through an
// untyped lookup and duck-type the result, as plugin-draw's `resolveSnapHandle` does.
type UntypedLookup = (id: string) => unknown
const snap = (ctx.tryPlugin as unknown as UntypedLookup)('snap') as
  | { exclude?(ids: readonly string[]): void; setInProgress?(points: readonly LngLat[]): void }
  | undefined

snap?.exclude?.([preview.id])

// The ring so far. Lets the user close it on its own first vertex, and gives the
// perpendicular provider something to be perpendicular *from*.
snap?.setInProgress?.(ring)
```

In an _application_ — which may import both packages — `map.plugin('snap')` is typed and
needs none of that ceremony. It is only a sibling plugin that has to go the long way
round, because `scripts/check-boundaries.mjs` fails the build on a plugin importing
another plugin.

See [ADR 0003](../../docs/adr/0003-snapping-as-interaction-middleware.md) for snapping as
middleware, and [ADR 0010](../../docs/adr/0010-tools-declare-what-they-drag.md) for how a
dragged feature is kept out of the auction.
