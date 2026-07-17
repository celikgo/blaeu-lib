# ADR 0005 — The store is WGS84; survey maths happens in a projected working CRS

Status: accepted

## Context

A parcel of 2 000 m² at 39°N — an unremarkable plot in Ankara. Compute its area two ways:

- **Spherical** (`@turf/area`, or any haversine-derived formula): treats the Earth as a
  sphere of a single radius and integrates over the ring.
- **Planar in EPSG:5254** (TUREF / TM30, the 3° transverse Mercator belt centred on 30°E):
  project each vertex to metres, then apply the shoelace formula.

The two answers differ by **square metres**. Not by a rounding error; by an amount that is
visible on a title deed, and that is enough to move a boundary in a dispute. The sphere is
the wrong model — the Earth is an ellipsoid, and more importantly the national grid a Turkish
cadastral coordinate is _defined in_ is a specific projection with a specific central
meridian, and the number the registry will accept is the number on that plane.

The same argument applies to every other survey-grade operation. A "2.5 metre" buffer applied
to degrees is a 280 km buffer — and it _renders_ without error, which is exactly why it
survives code review. A perpendicular foot computed in degrees is not perpendicular on the
ground. A parallel offset in degrees is not parallel.

Meanwhile: the store has to have _one_ interior coordinate system. The moment two flow
through the same pipe, every function downstream has to ask "which one is this?" and
eventually something guesses wrong — and a coordinate in the wrong CRS does not throw, it
renders, somewhere in the Gulf of Guinea.

## Decision

**Two rules, and they are not in tension.**

1. **The interior CRS is WGS84 `[lng, lat]`, always.** The store, every event payload, every
   `BlaeuFeature.geometry`, and the renderer speak EPSG:4326 without exception. It is what
   GeoJSON (RFC 7946) mandates, what MapLibre expects, and what every import and export
   format can round-trip.

2. **Anything a surveyor would sign happens in the projected working CRS, in metres.** The
   projection sandwich, which appears everywhere in the codebase and is worth learning once:

```ts
const plane = map.crs.working // EPSG:5254 — metres
const xy = ring.map(plane.forward) // 4326 → projected metres
const out = offsetPolygonPlanar(xy, 2.5) // the real maths, in real metres
const back = out.map(plane.inverse) // → 4326, back into the store
```

`CrsService` provides the sandwich pre-wrapped for the common cases: `area()` (planar m²),
`length()`, `distance()`, `bearing()` (**grid** bearing, clockwise from grid north — not a
geodesic azimuth; surveyors care), `quantise()` and `format()`/`parse()`.

The working CRS is also the display and export CRS, because a Turkish surveyor wants to read
and type `Y=458123.456 X=4421987.123`, not a pair of decimal degrees — that is the string
they compare against a coordinate schedule and read out over the phone.

`ProjectedCrs.precision` is the quantisation grid (1 mm for cadastre). Coordinates are
reduced to it **on ingest**, once, at the boundary — not on export. Two coordinates differing
by 10⁻¹² m are the same corner to a human and a different corner to a boolean operation, and
that difference is where slivers are born. The topology index keys on the quantised
coordinate for exactly this reason.

`measurePlugin` takes a `planar` option whose only supported value is `true`. It exists so
that `planar: false` fails **loudly at setup**, with a message that explains itself, rather
than silently doing sphere maths.

Turkish TUREF/TM belts (EPSG:5253–5259) and the legacy ED50 Gauss-Krüger belts
(EPSG:2319–2325) ship built in; `crs.register()` takes a municipality's local system, and
`preset-game` uses the same call to register a plane in arbitrary world units with no Earth
under it at all.

## Alternatives rejected

**Store everything in the projected CRS.** Numerically the cleanest: no projection on every
measurement, no round-trip error. Rejected because it makes the store's meaning depend on a
mutable setting — change the working CRS and every coordinate already in memory silently
means something else. It also breaks GeoJSON interchange, breaks the renderer (MapLibre wants
4326), and makes a dataset spanning two TM belts unrepresentable.

**Spherical maths everywhere (`@turf/*`).** Fast, tree-shakes, no proj4 dependency. Rejected
on the square-metres argument. Turf remains the right tool for cosmetics and globe-scale
work, and we use it where that is what is wanted (`plugin-select`'s point-in-polygon hit
test). It is the wrong tool for anything a land registry will read.

**Geodesic maths on the ellipsoid** (Karney / GeographicLib). Genuinely accurate, and the
right answer for long distances across the globe. Rejected because it answers the wrong
question: cadastral area is not "the true area on the ellipsoid", it is "the area on the
national grid plane", which is what the deed says and what the neighbouring parcel's area was
also computed on. Being more accurate than the legal definition is not more correct.

**A per-feature CRS tag.** Maximum flexibility. Rejected instantly: every consumer of a
geometry would have to check, and the first one that forgets produces a parcel in the sea.

## Consequences

- **Good.** Cadastral numbers are the numbers a registry accepts, and the code that produces
  them is short and auditable — `forward`, planar maths, `inverse`.
- **Good.** The kernel's planar facilities (snapping, grid quantisation, distance, area,
  topology) were all written against `crs.working` rather than against the Earth — which is
  the reason `preset-game` can register a plane in arbitrary units and have all of them work
  unchanged. The abstraction was not designed for that; it fell out, which is the best kind of
  evidence that it is the right one.
- **Bad.** `proj4` is a hard dependency of the core, and every precise operation pays a
  projection round trip. In practice it is negligible against the geometry it is wrapping.
- **Bad.** The working CRS has a validity extent, and using the wrong TM belt is not a
  rounding error — a parcel 6° from its central meridian is off by metres. `ProjectedCrs.bounds`
  exists to warn, but choosing the belt is still the preset author's responsibility.
- **Bad.** Two coordinate spaces means a plugin author can hold the wrong one. `LngLat` and
  `ProjectedXY` are distinct type aliases so the compiler keeps them apart, but they are both
  `readonly [number, number]` underneath, so a determined mistake is still possible.
- **Bad.** The working CRS is mutable (`setWorking`). `preset-game` swaps it during plugin
  setup, and the `InteractionContext.xy` getter re-reads the service on every access rather
  than capturing the plane, precisely so a mid-gesture change is not silently ignored. It is a
  sharp edge, and a `config.crs.register` hook would remove it.
