---
name: gis-geometry-precision
description: Which geometry library to reach for (Turf vs JSTS vs planar maths), and the coordinate-precision rules that keep cadastral work legally defensible. Use whenever writing code that computes area, distance, buffers, offsets, intersections, or validity — especially in snap, edit, measure, and topology.
---

# Geometry, precision, and which library to reach for

Getting this wrong doesn't crash. It produces plausible numbers that are quietly
wrong — which, in a land registry, is the worst possible failure mode.

## Choosing the library

| Job                                                                                                    | Use                                   | Why not the others                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simple measures on a globe (rough distance, bbox, centroid, along)                                     | `@turf/*`                             | Fine, fast, tree-shakes.                                                                                                                                                                                        |
| **Anything a surveyor signs**: area, offset, parallel, perpendicular foot, precise distance            | **planar maths in `map.crs.working`** | Turf's `area`/`distance` are spherical. On a 2 000 m² parcel at 39°N that's an error of _square metres_ — enough to move a boundary in a dispute.                                                               |
| Boolean ops, validity, topology: union, difference, `isSimple`, `isValid`, noding, precision reduction | **JSTS**                              | Turf's booleans (`@turf/union`, `polygon-clipping`) are floating-point and produce spikes, slivers and self-touching rings on adjacent parcels. JSTS has a real precision model and `GeometryPrecisionReducer`. |
| Nearest-feature / candidate prefetch                                                                   | `rbush` via `SpatialIndex`            | Don't linear-scan a 50 000-parcel collection on `pointermove`.                                                                                                                                                  |

The short version: **Turf for cosmetics and globe-scale, JSTS for correctness,
raw planar maths for survey-grade numbers.**

## The projection sandwich

Every precise operation follows the same three-step shape. Learn it once and the
rest of the codebase reads itself:

```ts
const plane = map.crs.working // EPSG:5254, metres
const xy = ring.map(plane.forward) // 4326 → projected metres
const out = offsetPolygonPlanar(xy, 2.5) // do the real maths, in metres
const ring2 = out.map(plane.inverse) // projected → 4326, back to store
```

Never do the maths in the middle step on lng/lat. A "2.5 metre" buffer applied to
degrees is a 280 km buffer, and the fact that this _renders_ without error is why
it survives review.

## Precision rules

**1. Reduce precision on ingest, not on export.** Snap all incoming coordinates
to the working CRS's precision grid (1 mm for cadastre) _once_, at the boundary.
Two coordinates that differ by 10⁻¹² metres are the same corner to a human and a
different corner to a boolean op, and that difference is where slivers are born.

```ts
const reducer = new GeometryPrecisionReducer(new PrecisionModel(1000)) // 1 mm
```

**2. Compare coordinates by tolerance, never by `===`.** Coordinate equality is
`distance < tolerance`, and the tolerance lives in the CRS config — not as a magic
number in your file. The topology index keys on a _quantised_ coordinate for
exactly this reason.

**3. Winding order matters and JSTS cares.** GeoJSON (RFC 7946) says exterior
rings are counter-clockwise, holes clockwise. Half the data in the wild violates
this. Normalise on ingest (`rewind`), because a wrongly-wound hole silently
becomes a second exterior ring and your area is now the sum, not the difference.

**4. Close your rings.** First coordinate must equal last, exactly, after
precision reduction. An unclosed ring is one of those things every library
handles differently and none handle well.

**5. Don't let float error accumulate across a drag.** Each `pointermove` during a
vertex drag must recompute from the _original_ geometry plus a total delta — never
from the previous frame's result. Otherwise a 200-frame drag compounds 200
rounding errors, and the vertex lands somewhere it wasn't dropped. (This is also
why `MoveVerticesCommand` stores `from` and `to`, not a per-frame delta.)

## Validity, and what to do about it

`isValid` failures worth knowing by name, because they're what real data throws:

- **Self-intersection** (the bowtie) — reject; auto-fixing it guesses at intent.
- **Ring self-touch** — a polygon pinched to a point. Legal in some formats,
  invalid in OGC. Reject.
- **Duplicate consecutive vertices** — clean silently on ingest. Nobody meant this.
- **Sliver** — a polygon with an absurd perimeter²/area ratio. Almost always a
  digitisation artefact, and worth _warning_ on rather than rejecting, because
  occasionally a genuine strip of land is that shape.

Never auto-fix geometry in a cadastral context without telling the user what
changed. `topologyPlugin({ autoFix: false })` is the correct default: the surveyor
decides, the software reports. Silently "correcting" a boundary is how software
loses the trust of the people whose job it is to be exactly right.
