# ADR 0013 — A GeometryCollection is flattened by the rules, and refused by the cadastre

Status: accepted · Amends: — · Amended by: —

## Context

`plugin-topology`'s `isPolygonal` was a two-line type test:

```ts
export function isPolygonal(feature: BlaeuFeature): boolean {
  return feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon'
}
```

It is not a two-line concern. That predicate is the `appliesTo` for **all seven** topology
rules, the stored-neighbour filter in `candidateNeighbours`, and the co-committed batch filter
in `batchInCollection`. So a geometry it rejects is not merely unchecked — it also becomes
invisible **as a neighbour**, which switches off the relational rules for the honest parcels
around it.

A `GeometryCollection` is rejected by that test, and a `GeometryCollection` is not exotic: it is
what ArcGIS, several DXF converters, and some municipal exports produce when a parcel's rings
travel together. Measured against a real `cadastrePreset({ crs: 'EPSG:5254' })`, two parcels
overlapping by 1 199.6 m² were correctly refused as Polygons, and committed `{ok: true}` with
zero issues when one was wrapped in a collection. A collection seeded alone then blinded a
plainly-overlapping _correct_ Polygon committed afterwards.

Nothing upstream stops it, and that is deliberate rather than accidental. Core supports
`GeometryCollection` on purpose: `normaliseGeometry` recurses into its members (including nested
ones), `CrsService.area` and `.length` sum them, `FakeRenderer` draws them, and `plugin-edit`
and `plugin-snap` each have an explicit arm for them. No ADR mentioned the type, and no test in
the repository named it.

## Decision

**Three tiers, three different answers, and the tier boundary is the whole point.**

**Core — unchanged.** A `GeometryCollection` is legitimate RFC 7946 and the kernel keeps storing
it. The kernel has never heard of a parcel, and "this shape is not a parcel" is not a kernel
opinion.

**`plugin-topology` — flatten, don't skip.** A new `polygonalGeometry(geometry)` returns the
polygonal content of a geometry — a `Polygon` or `MultiPolygon` unchanged, a collection reduced
to a `MultiPolygon` of every polygonal member found recursively, and `undefined` when there is
none. `isPolygonal`, `polygonRings` and `polygonParts` are all defined in terms of it, and so is
`prepare()`, the single conversion boundary into JSTS.

Putting the flattening in `prepare()` — the single conversion boundary into JSTS — is what makes
this safe rather than merely broader. Flattening is also the semantically correct reading: the
union of a collection's polygons is the ground it claims.

"Any polygonal member" rather than "all": non-areal members are ignored rather than being
grounds for refusal.

**`preset-cadastre` — refuse it, as an error.** Measurable is not the same as storable. A parcel
whose geometry is a collection has no single boundary, so `sınırlandırma` is undefined for it,
and the vertex tool cannot edit it at all — core's `eachVertex` deliberately declines to address
a collection's members, because `VertexRef` has no way to name one. Storing one produces a
parcel that looks fine on screen and is a dead end.

So `parcelGeometryTypeRule` reports a non-`Polygon`/`MultiPolygon` parcel as an **error**, scoped
to the parcel collection. Error rather than warning because the fix is mechanical — flatten to a
MultiPolygon on import — and the message says so, naming the offending type.

`deriveAreaMiddleware` widened its own copy of the predicate to match. That matters even though
the cadastre now refuses to store a collection, because the middleware runs _ahead_ of validation
in the pipeline, it is exported and usable standalone, and a host that lowers the geometry-type
rule to a warning must not end up with a stored parcel carrying no `yüzölçümü`.

## Alternatives rejected

**Reject a `GeometryCollection` at `normaliseGeometry`**, so nothing downstream ever sees one.
The tempting fix, and the cheapest: one guard, one error, seven rules and both neighbour filters
correct by construction. Rejected because it puts a _plugin's_ limitation into the kernel, in
direct tension with invariant 1, and because being honest about it would mean deleting
deliberate collection support from five other files — `normaliseGeometry`'s recursion,
`CrsService.area` and `.length`, `FakeRenderer`, and the explicit arms in `plugin-edit` and
`plugin-snap`. A preset that cannot store a shape is not evidence that the kernel cannot.

**Widen the predicate without flattening in `prepare()`.** Two characters in `isPolygonal`, and
the rules would start seeing collections. Rejected because JTS raises
`IllegalArgumentException: This method does not support GeometryCollection arguments` from every
overlay operation, so a collection reaching `intersection()` would trade a silent miss for a
crash — a worse failure at a worse moment, since it lands in the middle of a commit rather than
on import.

**Require _all_ members to be polygonal, rather than any.** Stricter, and defensible on the
grounds that a mixed collection is probably a conversion artefact. Rejected because a collection
carrying a parcel plus its address point is still a parcel, and refusing to check its geometry
because it also carries a point is the same silent miss by another route. Non-areal members are
ignored, not grounds for refusal.

## Consequences

A collection can no longer exempt itself, or its neighbours, from any topology rule. The seven
rules and both neighbour filters see its polygons.

The cadastre preset refuses to store a collection parcel, which is a **behaviour change for any
host importing GC-wrapped parcels**: those commits now fail with a `cadastre.geometryType` error
instead of silently storing an unvalidated, uneditable parcel. That is the intended trade — the
previous behaviour was the defect — and the remedy is one flattening pass at the import boundary.
Hosts that genuinely want them can rebuild the rule list; `parcelGeometryTypeRule` and
`PARCEL_GEOMETRY_RULE_ID` are exported for exactly that.

`preset-urban` and any third-party consumer of `plugin-topology` get the rule coverage without
the cadastre's refusal, which is the tiering working as intended.

What this ADR does **not** do: teach the vertex tool to edit a collection's members. That needs
an addressing scheme `VertexRef` does not have, and inventing one here would leak it into every
plugin that consumes a ref. A collection remains storable-but-uneditable in the kernel, and the
cadastre's error is the honest way to say so.

## Tests

- `packages/plugin-topology/src/geometry-collection.test.ts` — subject, neighbour, and
  co-committed-batch visibility; every member flattened rather than only the first; non-areal
  members ignored; a shared edge still not an overlap; a collection with no polygon at all
  neither reported nor crashing inside JTS.
- `packages/preset-cadastre/src/geometry-collection.test.ts` — the refusal, its message and
  severity, a Polygon and a MultiPolygon unaffected, the rule scoped to the parcel layer, and
  the area still derived when the rule is not in the way.

Both suites were confirmed to fail against the pre-fix predicate.
