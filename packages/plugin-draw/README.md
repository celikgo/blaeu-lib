# @fleximap/plugin-draw

Point, line, polygon, rectangle, circle and freehand — the drawing half of an editing
product, built on the FlexiMap kernel.

```bash
npm install @fleximap/plugin-draw
```

`@fleximap/core` is a **peer** dependency.

## Usage

```ts
import { createFlexiMap } from '@fleximap/core'
import { drawPlugin } from '@fleximap/plugin-draw'

const map = await createFlexiMap({
  container: '#map',
  plugins: [
    drawPlugin({
      collection: 'parcels',
      circleSegments: 64,
      freehandTolerance: 0.5, // metres, in the working CRS
      properties: () => ({ source: 'field-survey', drawnAt: Date.now() }),
    }),
  ],
})

map.plugin('draw').start('polygon') // → DrawApi, no cast
map.events.on('draw:complete', (e) => {
  console.log(map.crs.area(e.payload.feature.geometry), 'm²')
})
```

## What it registers

| Kind       | Id                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------- |
| Tools      | `draw:point`, `draw:line`, `draw:polygon`, `draw:rectangle`, `draw:circle`, `draw:freehand` |
| Collection | `draw:preview` — the shape in progress, and nothing else                                    |
| Commands   | `core:add-features` (the completed shape), `draw:set-preview` (transient)                   |

Activate a tool either way — they are the same thing:

```ts
map.tools.activate('draw:rectangle')
map.plugin('draw').start('rectangle')
```

## What it depends on

| Plugin    | Required?    | What it adds                                                                     |
| --------- | ------------ | -------------------------------------------------------------------------------- |
| `snap`    | **optional** | Vertices land on snap targets, and a ring can be closed on its own first corner. |
| `history` | **optional** | Ctrl-Z undoes a shape. Without it the shapes still land; nothing records them.   |

Both degrade to nothing. The plugin never imports either one, and `draw.test.ts` proves it
draws with neither installed.

### How snapping reaches the tools

It doesn't — not directly, and that is the design. Snapping is _interaction middleware_: it
rewrites `ctx.lngLat` before any tool sees the event. By the time a draw tool reads the
pointer position, it has already been pulled onto a parcel corner, locked to a grid, or
constrained to an axis, by middleware this package has never heard of.

The one thing the draw plugin tells the snap engine is what it cannot know for itself:

- the vertices of the ring **in progress** — they are not in the store yet, and without them
  the user could never close a ring by clicking its first corner;
- the id of the **preview feature**, to exclude — or the rubber band would snap to itself.

Both go through a duck-typed, fully-guarded handle (`snap-handle.ts`), because a plugin may
not import another plugin.

## Events

| Event                  | Payload                         | Notes                                                            |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `draw:start`           | `{ mode }`                      | A tool was activated.                                            |
| `draw:vertex`          | `{ mode, vertex, vertices }`    | A vertex was committed (or captured, for freehand).              |
| `draw:complete`        | `{ mode, collection, feature }` | The shape is in the store. `feature` is the real `FlexiFeature`. |
| `draw:cancel`          | `{ mode, reason }`              | Escape, a veto, a degenerate shape, or the tool going away.      |
| `before:draw:complete` | `{ mode, collection, feature }` | **Cancellable.** `feature` is a `FeatureInput` — no id yet.      |

`before:draw:complete` fires before anything is dispatched, so `preventDefault(reason)`
leaves nothing behind: no feature, no history entry, no preview.

```ts
map.events.onBefore('before:draw:complete', (e) => {
  if (map.crs.area(e.payload.feature.geometry) < 50) {
    e.preventDefault('a parcel must be at least 50 m²')
  }
})
```

## Behaviour worth knowing

**Polygon / line.** Click to add a vertex. Double-click, press Enter, click the first corner
(polygon only), or call `finish()` to close. Backspace removes the last vertex, Escape
abandons the shape and leaves the tool armed for the next one.

**Rectangle.** Press-drag-release, axis-aligned **in the working CRS**. A rectangle that is
axis-aligned in lng/lat is a trapezoid on the ground — its sides are not parallel and its
corners are not 90° — so the corners are computed in the projected plane and projected back.

**Circle.** Press at the centre, drag for the radius, release. The radius is a planar
distance in metres in the working CRS, not a great-circle distance. GeoJSON has no circle, so
the shape is stored as a polygon of `circleSegments` vertices — and the _true_ centre and
radius are stashed in the properties (`draw:centre`, `draw:radiusMetres`, `draw:segments`,
`draw:shape === 'circle'`) so an editor can re-derive the exact circle instead of guessing it
back from 64 rounded vertices.

**Freehand.** Press, trace, release. The captured path is simplified with Douglas-Peucker at
`freehandTolerance` metres, in the projected plane, and stored as a `LineString`. This is not
an optimisation: a raw trace is thousands of near-collinear points, many closer together than
the CRS's precision grid, and it will produce spikes and slivers in any topology check or
boolean op it reaches.

**The preview never enters the undo stack.** The shape in progress lives in the `draw:preview`
collection and is written with a _transient_ command, so pressing Ctrl-Z mid-draw undoes the
last real action rather than stepping back through the cursor's path one sample at a time.
Each completed shape is exactly one undo step.

## Options

| Option              | Default      | Meaning                                                                    |
| ------------------- | ------------ | -------------------------------------------------------------------------- |
| `collection`        | `'default'`  | Where completed shapes land. Retarget later with `setCollection`.          |
| `defaultMode`       | —            | A tool to activate as soon as the plugin is installed.                     |
| `freehandTolerance` | `1`          | Douglas-Peucker tolerance, in metres in the working CRS.                   |
| `circleSegments`    | `64`         | Vertices used to approximate a circle.                                     |
| `properties`        | `() => ({})` | Called once per shape; its result is merged into the feature's properties. |

## API

```ts
interface DrawApi {
  start(mode: DrawMode): void
  cancel(): void
  finish(): void
  readonly active: DrawMode | null
  readonly vertices: readonly LngLat[]
  setCollection(id: CollectionId): void
}
```
