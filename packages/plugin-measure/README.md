# @fleximap/plugin-measure

Distance, area and grid bearing — **planar, in the working CRS, in metres**.

Every number this plugin reports comes out of `ctx.crs.area() / length() / distance() / bearing()`.
Nothing here does its own geometry, and nothing here is spherical. That is the point of the package:
on the 2 000 m² parcel at 39°N that this repo measures everything against, a spherical area and the
projected one disagree by square metres, and a boundary dispute is decided by less. There is a test
named after that (`the planar (EPSG:5254) area and the spherical area … DIFFER`) so nobody
"optimises" it into `@turf/area` later.

```bash
npm install @fleximap/plugin-measure
```

## Usage

```ts
import { createFlexiMap } from '@fleximap/core'
import { measurePlugin } from '@fleximap/plugin-measure'

const map = await createFlexiMap({
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

## Options

| Option       | Default | Notes                                                                                                                                                                      |
| ------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `areaUnit`   | `'m2'`  | `'m2'` \| `'ha'` \| `'km2'` \| `'donum'`. **dönüm = 1 000 m²** — the unit a Turkish surveyor reads a parcel in, and what the cadastre preset selects.                      |
| `lengthUnit` | `'m'`   | `'m'` \| `'km'`                                                                                                                                                            |
| `persist`    | `true`  | `false` gives ruler behaviour: starting a new measurement clears the last.                                                                                                 |
| `planar`     | `true`  | The only supported value. `planar: false` **throws**, with a message explaining why — a silent downgrade to sphere maths under a survey tool is a trapdoor, not a feature. |

Numbers are formatted through `ctx.i18n`, never `toFixed()`: Turkish gets `1.234,56 m²`, and an
English-formatted `1,234.56` in a Turkish UI is not merely foreign, it is ambiguous.

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
