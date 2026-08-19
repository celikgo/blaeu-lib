# Coordinate reference systems

> Every number on this page was computed by running the library, not recalled. The script is
> reproduced in full under [Reproducing the numbers](#reproducing-the-numbers); paste it into
> the repo after `npm run build` and you will get the same output.

A map editor that stores WGS84 and measures in WGS84 is fine for a delivery-route app and
useless for a land registry. Blaeu separates the two questions — _where is this held_ and
_where is this measured_ — and that separation is the whole of this document.

- **The store is WGS84.** Every geometry in the feature store is `[lng, lat]` in EPSG:4326.
  One interior representation, so a projected coordinate can only ever be produced from a
  lng/lat, never from another projected coordinate somebody forgot to unproject.
- **Survey mathematics happens in a projected working CRS.** Area, length, distance, bearing,
  snap tolerances, the topology grid and the quantisation grid are all evaluated in a plane,
  in metres. Not once in degrees.

ADR [0005](adr/0005-wgs84-interior-projected-working-crs.md) records why.

## Why this matters, in square metres

Take a parcel in Ankara: a 40 m × 50 m rectangle, exactly 2 000 m², laid out on the TUREF/TM33
grid with its south-west corner at `E 486321.250, N 4421987.500`. Unproject it to WGS84, hand
it to the store, and then ask three different working CRSs for its area:

| Working CRS | Name                     |        Area | Error vs. ground truth |
| ----------- | ------------------------ | ----------: | ---------------------: |
| `EPSG:5255` | TUREF / TM33             | 2000.000 m² |              **exact** |
| `EPSG:5254` | TUREF / TM30             | 2002.894 m² |    +2.894 m² (+0.14 %) |
| `EPSG:3857` | WGS 84 / Pseudo-Mercator | 3405.467 m² | +1405.467 m² (+70.3 %) |

Three readings of one parcel. All three look like plausible areas. Only one is the parcel.

The Web Mercator row is why the default working CRS is never survey-grade: its scale factor is
`1 / cos(latitude)`, so at Ankara's 39.93 °N a "metre" on that plane is 1.30 real metres and a
planar area comes out ~70 % too large. It is the default because it is the only choice that is
never _catastrophically_ wrong for a map that has not yet said where it is — and it is
documented, loudly, as a thing to replace before measuring anything that will be signed.

The TM30 row is subtler and more dangerous, because 0.14 % does not look like an error. Ankara
is 32.85 °E: 0.15° from TM33's central meridian, and 2.85° from TM30's. A 3-degree TM belt is
designed for ±1.5°, and grid scale error grows quadratically with distance from the central
meridian. Getting the belt wrong does not produce a number a reviewer would question — it
produces a parcel that is 2.9 m² larger than the land it describes. Blaeu refuses to be quiet
about it: `crs.withinBounds()` returns `false` for this parcel under TM30, and every belt in
the registry carries its ±1.5° envelope for exactly this check.

## Which Turkish systems are supported

All of these are built in. Nothing has to be registered to use them.

### TUREF — the modern national frame

**Türkiye Ulusal Referans Çerçevesi**: ITRF96 epoch 2005.0 on GRS80. It agrees with WGS84 far
below anything a receiver can measure, so its `towgs84` is the seven zeros — and a TUREF↔WGS84
conversion is lossless in practice. That is precisely what makes it safe for this library to
hold everything in WGS84 interiorly and still hand a surveyor numbers they can sign. This is
the system a Turkish cadastral survey is delivered in today.

| EPSG   | Name         | Central meridian | Longitude envelope | Roughly covers                        |
| ------ | ------------ | ---------------- | ------------------ | ------------------------------------- |
| `5253` | TUREF / TM27 | 27 °E            | 25.5 – 28.5 °E     | İzmir, Balıkesir, Çanakkale, Muğla    |
| `5254` | TUREF / TM30 | 30 °E            | 28.5 – 31.5 °E     | İstanbul, Bursa, Antalya, Eskişehir   |
| `5255` | TUREF / TM33 | 33 °E            | 31.5 – 34.5 °E     | Ankara, Konya, Karabük                |
| `5256` | TUREF / TM36 | 36 °E            | 34.5 – 37.5 °E     | Adana, Kayseri, Samsun, Mersin, Sivas |
| `5257` | TUREF / TM39 | 39 °E            | 37.5 – 40.5 °E     | Malatya, Elazığ, Trabzon, Diyarbakır  |
| `5258` | TUREF / TM42 | 42 °E            | 40.5 – 43.5 °E     | Erzurum, Kars, Van, Ağrı              |
| `5259` | TUREF / TM45 | 45 °E            | 43.5 – 46.5 °E     | Hakkâri, and the eastern border       |

All seven are 3-degree transverse Mercator with `k=1`, false easting 500 000 m, false northing 0. Latitude envelope is Türkiye's onshore span, 35.5 – 42.5 °N.

### ED50 — the legacy archive

`EPSG:2319` – `EPSG:2325`, the ED50 3-degree Gauss-Krüger belts on the International 1924
ellipsoid, same central meridians 27 – 45 °E. Decades of Turkish cadastral archive live in
these, and an importer that cannot read them cannot read Turkish data.

Two warnings ship with them, and both have bitten people:

1. **The datum shift is approximate.** `-84.1,-101.8,-129.7,0,0,0.468,1.05` is the published
   national Helmert transform. It is good to a couple of metres — fine for _displaying_ an
   archived parcel over a modern basemap, useless for _certifying_ a boundary. A legally
   defensible ED50→TUREF conversion in Türkiye uses the official regional transformation,
   which is not a seven-parameter shift and is not something this library pretends to do.
   **Convert for viewing; do not convert for the deed.**
2. **Legacy eastings are often zone-prefixed.** Much archived data writes the belt number in
   front of the easting — `10 458 123.456` in zone 10, not `458 123.456` — a convention proj4
   knows nothing about. An importer must strip it. A parcel that lands 10 000 km east of
   Türkiye has met exactly this.

### Also built in

`EPSG:32635` / `32636` / `32637` (WGS 84 / UTM 35N, 36N, 37N), which cover Türkiye and turn up
constantly in imported data; and `EPSG:3857`, the default, discussed above.

### Deliberately _not_ registered

- **EPSG:5636–5642 as the ED50 belts.** They are not. `EPSG:5636` is _TUREF / LAEA Europe_, an
  equal-area projection for statistics. Registering the ED50 belts under those numbers would
  have produced a system that projected, measured, and lied. The verified ED50 belts are
  2319–2325.
- **EPSG:4326 as a working CRS.** It is geographic, not projected. `setWorking('EPSG:4326')`
  is refused by name, with a message, rather than silently accepted as a plane whose "metres"
  are degrees.
- **Municipal and utility grids.** Every large Turkish municipality has one, and guessing at
  them is the exact mistake the refusal list exists to prevent. They arrive through
  `map.crs.register({ code: 'IZMIR-BB-LOCAL', name, proj4, unit, precision })`, from the
  authority that owns the definition.

A registered definition is round-trip probed at registration, not on first use: `forward` then
`inverse` on the centre of its own bounds must come back within 1 × 10⁻⁶ degrees, or `register()`
throws. That tolerance is deliberately generous — it is a smoke test for _is this a working
projection at all_, not a precision assertion, and a definition that round-trips a whole degree
off is broken in a way no tolerance forgives. The point is _when_ it fails: a bad proj4 string
that throws at `register()` names itself, where the same string failing on the first
`pointermove` of a drag surfaces as a vertex jumping into the Gulf of Guinea.

## The precision guarantees

### Quantisation is in metres on the grid, not decimal places on the lng/lat

`crs.precision: 3` means **three decimal places in the working CRS's unit** — millimetres, for
every metre-based system above. It does not mean three decimal places of longitude, which at
Turkish latitudes would be a ~85 m grid.

`crs.quantise(lngLat)` therefore projects, snaps to the grid _in the plane_, and unprojects:

```
raw        32.839974593670, 39.931968749723   ->  E 486321.258568  N 4421987.511088
quantised  32.839974598729, 39.931968748937   ->  E 486321.259000  N 4421987.511000
```

The lng/lat that comes back is not "rounder" than the one that went in — it is deliberately
uglier. It is the lng/lat that lands exactly on a millimetre of the TM33 grid, which is the
only roundness that means anything to a surveyor. The store quantises on ingest, so this is
the grid every stored vertex sits on.

A CRS whose declared precision is not a finite positive grid size is refused at registration.

### Topological vertex identity

The topology index buckets vertices by their **quantised projected** position: divide by the
precision grid, round to an integer cell. Two parcels that share a corner land in one bucket
with two vertex references, so `moveVertex` on that corner moves both parcels in a single
command — and the boundary between them cannot come apart.

Rounding to a grid has a boundary problem, and it is handled rather than ignored: two corners
0.4 mm apart can straddle a cell edge and round _away_ from each other into adjacent cells.
Keying alone would call them different corners, and the software would have manufactured a
0.4 mm sliver between two parcels the surveyor drew as touching. In a land registry that is
not a rendering artefact; it is a strip of land with no owner. So a lookup reads the 3×3 block
of cells around the query point and keeps everything within one grid cell (Chebyshev distance
≤ the grid). **The tolerance is the CRS's declared precision**: at 1 mm, two corners closer
than 1 mm are the same corner by definition, and any tool claiming to distinguish them is
lying about its accuracy.

### Area is planar, and the shoelace sum is translated first

`crs.area()` runs a shoelace sum in the projected plane. Two details are load-bearing:

- **The sum is taken relative to the ring's first vertex, not the origin.** A Turkish northing
  is ~4.4 × 10⁶, so a naive shoelace multiplies numbers of order 10¹¹ and subtracts them to
  recover a value of order 10³. That cancellation throws away roughly six significant digits —
  enough to move a small parcel's area by square centimetres, and enough to make the result
  depend on _where in the world_ the parcel is. Translating to a local origin first keeps every
  product at the scale of the parcel itself.
- **Holes are subtracted by absolute area, not signed area.** RFC 7946 says exterior rings wind
  counter-clockwise and holes clockwise; a large fraction of the data a land registry receives
  ignores that. Trusting the sign would make a wrongly-wound hole _add_ its area — turning a
  courtyard into extra land. Ring position in the array is the only signal GeoJSON actually
  guarantees, so that is the signal used.

### Bearings are grid bearings

`crs.bearing()` returns degrees clockwise from **grid north** — the +y axis of the projection —
in `[0, 360)`. Not true north, not magnetic north. Meridian convergence reaches ~1° at the edge
of a 3-degree belt at Turkish latitudes, so the two are not interchangeable. Surveyors read and
stake grid bearings, because those are what the coordinates on the plan actually mean.

### Display formatting follows the working CRS

With `display: 'projected'`, a coordinate readout is a grid reference in the local convention —
northing labelled `X`, easting labelled `Y`:

```
Y=486321.250  X=4421987.500
```

Decimal places are derived from the CRS's precision, so a millimetre grid reads to the
millimetre and never to a false fifth decimal.

## A worked parcel

The rectangle used throughout this page: 40 m × 50 m on the TUREF/TM33 grid, south-west corner
at `E 486321.250, N 4421987.500`, near Ankara.

| Corner | Easting (m) | Northing (m) | Longitude      | Latitude       |
| ------ | ----------: | -----------: | -------------- | -------------- |
| SW     |  486321.250 |  4421987.500 | 32.839974494°E | 39.931968650°N |
| SE     |  486361.250 |  4421987.500 | 32.840442446°E | 39.931969295°N |
| NE     |  486361.250 |  4422037.500 | 32.840441400°E | 39.932419608°N |
| NW     |  486321.250 |  4422037.500 | 32.839973445°E | 39.932418963°N |

Note that the four longitudes are not two values. The east edge's two corners differ by about
1 µ°, and so do the west edge's — because a rectangle on the TM33 grid is not a rectangle in
lng/lat, and the projection is doing real work. This is exactly the discrepancy that gets
flattened by software that stores degrees and measures degrees.

Measured back out of the store, in TM33:

```
area             2000.000 m²
perimeter         180.000 m
SW → SE distance   40.000 m
SW → SE bearing    90.0000°  from grid north
SW → NW bearing   359.99999999°  from grid north
```

That last one is worth reading rather than glossing. The edge is due north and the honest
answer is 0°; what comes back is 359.99999999…°, four picodegrees short — the accumulated
floating-point cost of the forward/inverse round trip through the store's WGS84. It is well
inside `[0, 360)`, it is roughly a nanometre on the ground, and it is displayed as `0.000` at
any precision the CRS declares. It is shown here undressed because a page about precision
guarantees that quietly rounded its own example would be the wrong kind of document.

## Reproducing the numbers

After `npm install && npm run build` at the repo root:

```js
import { BlaeuCrsService } from '@blaeu/core'

const tm33 = new BlaeuCrsService({ working: 'EPSG:5255', display: 'projected', precision: 3 })
const plane = tm33.working

const E = 486321.25,
  N = 4421987.5
const cornersXY = [
  [E, N],
  [E + 40, N],
  [E + 40, N + 50],
  [E, N + 50],
  [E, N],
]
const ring = cornersXY.map((xy) => plane.inverse(xy))
const parcel = { type: 'Polygon', coordinates: [ring] }

for (const code of ['EPSG:5255', 'EPSG:5254', 'EPSG:3857']) {
  const s = new BlaeuCrsService({ working: code, display: 'projected', precision: 3 })
  console.log(code, s.working.name, s.area(parcel).toFixed(3), 'm2')
}

console.log(tm33.format(ring[0])) //  Y=486321.250  X=4421987.500
console.log(tm33.withinBounds(ring[0])) //  true   — and false under EPSG:5254
```

## Using it

```ts
import { createBlaeuMap } from '@blaeu/core'
import { cadastrePreset } from '@blaeu/preset-cadastre'

const map = await createBlaeuMap({
  container: '#map',
  preset: cadastrePreset({ crs: 'EPSG:5255', locale: 'tr' }), // Ankara belt, mm grid
})
```

Or without a preset, on the kernel directly:

```ts
const map = await createBlaeuMap({
  container: '#map',
  crs: { working: 'EPSG:5255', display: 'projected', precision: 3 },
  plugins: [snapPlugin({ tolerance: 12 }), drawPlugin({ collection: 'parcels' }), historyPlugin()],
})

map.crs.setWorking('EPSG:5254') // switching belts is a runtime operation
map.crs.onChange((crs) => console.log('now measuring in', crs.name))
```

`setWorking` swaps the plane and notifies every `onChange` subscriber, which is how derived
state — the topology index above all, since its buckets are grid cells of the old CRS — rebuilds
against the new grid. A no-op call to the CRS already in force does not fire, so a redundant
`setWorking` cannot trigger a full index rebuild. A subscriber that throws is logged and the
rest still run: a half-updated set of derived indexes is worse than a logged error. Switching
belts mid-session is supported; switching to a geographic code such as EPSG:4326 is refused.

## Related

- [ADR 0005](adr/0005-wgs84-interior-projected-working-crs.md) — WGS84 interior, projected working CRS
- [ADR 0007](adr/0007-jsts-over-turf-for-topology.md) — JSTS over Turf, and why topology runs in metres
- [`packages/core/src/crs/registry.ts`](../packages/core/src/crs/registry.ts) — every definition, with its provenance
- [`packages/core/src/crs/planar.ts`](../packages/core/src/crs/planar.ts) — the planar maths, and what each guard is for
- [`packages/preset-cadastre`](../packages/preset-cadastre/README.md) — the judgement layer: severities, tolerances, ada/parsel
