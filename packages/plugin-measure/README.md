# @blaeu/plugin-measure

Distance, area and grid bearing — **planar, in the working CRS, in metres**.

Every number this plugin reports comes out of `ctx.crs.area() / length() / distance() / bearing()`.
Nothing here does its own geometry, and nothing here is spherical. That is the point of the package:
on the 2 000 m² parcel at 39°N that this repo measures everything against, a spherical area and the
projected one disagree by square metres, and a boundary dispute is decided by less. There is a test
named after that (`the planar (EPSG:5254) area and the spherical area … DIFFER`) so nobody
"optimises" it into `@turf/area` later.

```bash
npm install @blaeu/plugin-measure
```

> Not on npm yet — see [the root README](../../README.md#packages) for how to run it from source.

## Usage

```ts
import { createBlaeuMap } from '@blaeu/core'
import { measurePlugin } from '@blaeu/plugin-measure'

const map = await createBlaeuMap({
  container: '#map',
  // The plane the numbers live on. Get this wrong and everything below is wrong:
  // EPSG:3857 at Ankara inflates area by 1/cos²φ ≈ 1.7.
  crs: { working: 'EPSG:5254' }, // TUREF / TM30
  plugins: [measurePlugin({ areaUnit: 'donum', lengthUnit: 'm' })],
})

map.plugin('measure').start('area') // typed — no cast, no generic
map.events.on('measure:complete', (e) => {
  console.log(e.payload.measurement.label) // '2,003 dönüm'
})

// Measure something that already exists, without writing anything to the store:
const parcel = map.plugin('measure').measureFeature('parcel-42')
console.log(parcel.areaMetres2, parcel.segments[0]?.bearingDegrees)
```

## What it registers

| Kind            | Ids                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Tools**       | `measure:distance`, `measure:area`, `measure:bearing`                                                                 |
| **Collections** | `measure`, `measure-labels`, `measure-draft`, `measure-draft-labels`                                                  |
| **Layers**      | `measure:geometry`, `measure:labels`, `measure:draft`, `measure:draft-labels`                                         |
| **Commands**    | `measure:replace-collections` (transient — the rubber band), plus core's `core:add-features` / `core:remove-features` |
| **i18n**        | `measure.*` keys in `en` and `tr`                                                                                     |

All of it goes through `ctx.disposables`, and `destroy()` additionally drops the four collections —
a `DisposableStore` can release a layer, but it cannot release the data behind it.

The ids are exported as `TOOL_IDS`, `LAYER_IDS` and the four collection constants
(`MEASURE_COLLECTION`, `LABEL_COLLECTION`, `DRAFT_COLLECTION`, `DRAFT_LABEL_COLLECTION`), and the
formatters (`formatArea`, `formatLength`, `formatBearing`, `toDms`) are exported standalone, so an
attribute panel can render the same strings the map does.

`map.plugins.disable('measure')` drops the half-drawn shape and switches the tool off, but leaves every
completed measurement on the map — a user who toggles the panel shut and open again expects their
numbers to still be there.

## What it depends on

Nothing, hard. `snap` is declared **optional** and is never called: snapping rewrites `ctx.lngLat` in
interaction middleware, upstream of every tool, so measuring between two parcel corners lands on them
exactly with zero lines of snapping code in this package. Without the snap plugin you measure exactly
where you clicked, which is what an un-snapped map should do — and there is a degradation test proving it.

## Events

| Event              | Payload                 | When                                                             |
| ------------------ | ----------------------- | ---------------------------------------------------------------- |
| `measure:start`    | `{ mode }`              | A measure tool is activated                                      |
| `measure:update`   | `{ mode, measurement }` | Every pointer move while a shape is open (`draft: true`)         |
| `measure:complete` | `{ measurement }`       | A shape is committed (double-click, Enter, or 2nd bearing click) |
| `measure:clear`    | `{ count }`             | `clear()` removed `count` measurements                           |

None are `before:`-prefixed: measuring writes nothing a host app could reasonably want to veto.

`measure:complete` fires only if the commit pipeline accepts the shape. A validation rule that
vetoes the write leaves the half-drawn shape on screen, logs a warning, and fires nothing — the
vertices stay put so the user can adjust rather than redraw. A double-click before the mode's
minimum vertex count (2 / 3 / 2) is likewise a no-op.

## Options

| Option       | Default | Notes                                                                                                                                                                      |
| ------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `areaUnit`   | `'m2'`  | `'m2'` \| `'ha'` \| `'km2'` \| `'donum'`. **dönüm = 1 000 m²** — the unit a Turkish surveyor reads a parcel in, and what the cadastre preset selects.                      |
| `lengthUnit` | `'m'`   | `'m'` \| `'km'`                                                                                                                                                            |
| `persist`    | `true`  | `false` gives ruler behaviour: starting a new measurement clears the last.                                                                                                 |
| `planar`     | `true`  | The only supported value. `planar: false` **throws**, with a message explaining why — a silent downgrade to sphere maths under a survey tool is a trapdoor, not a feature. |

Numbers are formatted through `ctx.i18n`, never `toFixed()`: Turkish gets `1.234,56 m²`, and an
English-formatted `1,234.56` in a Turkish UI is not merely foreign, it is ambiguous.

Existing measurements are re-labelled live. Switching locale re-formats every number on the map;
switching the working CRS (`map.crs.setWorking('EPSG:5255')`) re-derives them — areas and lengths,
not just their wording — because a measurement is stored as geometry and read through the live CRS.
Both rewrites are transient, so neither lands on the undo stack.

## API

```ts
interface MeasureApi {
  start(mode: MeasureMode): void
  clear(): Promise<void>
  readonly measurements: readonly Measurement[]
  measureFeature(id: FeatureId): Measurement
}

interface Measurement {
  readonly id: FeatureId
  readonly mode: MeasureMode
  readonly geometry: LineString | Polygon
  readonly positions: readonly LngLat[]
  readonly value: number // m² for area, metres for distance, degrees for bearing — raw
  readonly label: string // that value, converted and localised: '1.234,56 m²'
  readonly lengthMetres: number
  readonly areaMetres2: number // 0 unless the geometry is a closed ring
  readonly segments: readonly MeasureSegment[]
  readonly bearing?: BearingReadout // mode: 'bearing' only
  readonly draft: boolean // true while the pointer still owns the last vertex
}
```

`clear()` is a `Promise` because it removes every completed measurement through the commit
pipeline, as one undoable step — a validation rule gets to see the removal like any other write.
`measurements` is derived from the store rather than cached beside it, so an undo shrinks it
without the plugin being told. `measureFeature` **throws** on an id the store has never heard of,
or on a geometry that is neither a `LineString` nor a `Polygon`: measuring a point is not a
question with an answer, and returning `0` would let it reach a report.

## Interaction

- **Click** adds a vertex. **Double-click** or **Enter** finishes. **Escape** abandons the shape; a
  second Escape leaves the tool.
- A **bearing** completes on the second click — a line that cannot grow does not need a double-click.
- The rubber-band segment carries its own length before it is committed, which is the number the user
  is actually watching while they decide where to click next.
- Labels sit at each segment's **planar** midpoint and at the polygon's **area-weighted planar
  centroid**, styled entirely from theme tokens — so a preset that repaints the map repaints these too.

## Undo

One measurement is one undo step, even though it writes geometry and labels into two collections: the
commit is a single `transaction`. The rubber band is written with `transient` commands, so dragging the
pointer across a parcel does not deposit two hundred entries in the undo stack. `undo(execute(s))`
restores the store to **deep equality** — there is a test.
