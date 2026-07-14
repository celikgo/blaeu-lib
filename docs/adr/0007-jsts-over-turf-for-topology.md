# ADR 0007 — JSTS for topology and booleans; Turf only for cosmetics

Status: accepted

## Context

`plugin-topology` and `plugin-edit` need boolean operations and validity predicates: union
(merge two parcels), difference and intersection (find an overlap), `isSimple` / `isValid`
(reject a bowtie), noding, and precision reduction. The obvious JavaScript options are
`@turf/*` (which delegates its booleans to `polygon-clipping` / `martinez`), and JSTS (a port
of JTS, the Java Topology Suite, which is the engine behind PostGIS and GEOS).

Turf is smaller, tree-shakes properly, has a pleasant API and no ceremony. JSTS is a Java port
with a Java shape: factories, geometry readers and writers, and deep-import paths that need
their own `.d.ts` shims. On developer experience it is not close.

But this is the code that decides whether two parcels overlap, and the failure mode of the
convenient option is not a crash.

Float-based clipping libraries produce **artefacts on nearly-degenerate input**: two parcels
that share a boundary exactly — which is the normal case in a cadastre, because the shared
edge was digitised once and reused — hit the exact case where a floating-point intersection
test is most fragile. The union of two such parcels comes back with a spike; the difference
comes back with a sliver of 10⁻⁹ m²; a self-touching ring comes back as valid. None of these
throw. They render. And then a rule reports an "overlap" of 0.0000003 m² between two parcels
that a surveyor knows perfectly well share a boundary, the surveyor learns that the overlap
warnings are noise, and the day a _real_ 3 m² overlap appears they dismiss it too.

A slightly wrong boolean result in a cadastre is worse than an exception, because an
exception gets fixed.

## Decision

**JSTS for anything topological. Turf only for cosmetics and globe-scale approximations.
Raw planar maths for survey-grade numbers.**

| Job                                                                  | Library                            |
| -------------------------------------------------------------------- | ---------------------------------- |
| Boolean ops, validity, `isSimple`, noding, precision reduction       | **JSTS**                           |
| Area, length, offset, perpendicular foot — anything a surveyor signs | **planar maths in `crs.working`**  |
| Point-in-polygon hit tests, rough distance, bbox, centroid           | `@turf/*`                          |
| Nearest-feature and candidate prefetch                               | `rbush`, via core's `SpatialIndex` |

The decisive capability is JTS's **precision model**. JSTS can be told that coordinates live
on a 1 mm grid, and then reason _consistently_ on that grid:

```ts
// jsts.ts — JTS's PrecisionModel is a *scale*, not a grid size: 1 mm ⇒ scale 1000.
const model = new PrecisionModel(1 / precisionMetres)
return GeometryPrecisionReducer.reduce(geometry, model)
```

Everything entering an overlay operation is reduced to that grid first. Two corners 0.4 mm
apart become the _same_ corner, deliberately, before the boolean runs — so the operation
cannot manufacture a sliver between them, because on its model they are not apart.

Both plugins run JSTS on geometry that has already been projected into the working CRS, in
metres (ADR 0005). A precision model of "1 mm" is meaningless in degrees.

Neither library appears in the core. `jsts` is a dependency of `plugin-topology` and
`plugin-edit` only — which is why `preset-game`, which installs neither, ships a bundle with
no JSTS in it at all.

## Alternatives rejected

**`@turf/union` / `@turf/difference` (polygon-clipping).** Rejected on the sliver argument
above: floating-point clipping with no precision model manufactures spikes and slivers on
exactly the input a cadastre produces most (shared edges). It is a fine library for cosmetic
overlays, and we keep Turf for that.

**`martinez-polygon-clipping` directly.** Same class of problem, one dependency less.

**WASM GEOS** (`geos-wasm` and friends). The genuinely correct long-term answer: it is the
same C++ engine PostGIS uses, with a real precision model and considerably better performance
on large overlays. Rejected _for now_ on three counts: the bundle is a large WASM blob to ship
to a browser that may only ever draw one polygon; the async initialisation infects the plugin
setup path; and the ergonomics of moving geometry across the WASM boundary need care to not
be slower than JSTS for the small-n case, which is the common one. It is on the roadmap as an
_optional_ engine behind the same plugin API — the plugin owns the engine, so swapping it is a
plugin-internal change, not a contract change. This ADR is what makes that swap cheap.

**Rolling our own exact-predicate boolean layer** (Shewchuk arithmetic + a scanline). Rejected
without much agonising. Computational geometry is a field where the difference between "works
on my test cases" and "correct" is measured in decades of bug reports, and JTS has had those
decades.

## Consequences

- **Good.** Overlap and gap detection are correct on the input that matters — adjacent
  parcels sharing an exactly-coincident boundary. `sliverParcels()` (two parcels 0.4 mm apart)
  is a test fixture precisely so that a refactor which reintroduces slivers fails loudly.
- **Good.** `GeometryPrecisionReducer` gives us one place to enforce coordinate precision
  before an overlay, which is the same grid the topology index quantises to. One number, one
  meaning.
- **Bad.** Bundle size. JSTS is large and does not tree-shake well; we deep-import specific
  modules (`jsts/org/locationtech/jts/geom/PrecisionModel.js`) to limit the damage, and carry
  hand-written `.d.ts` shims for those paths.
- **Bad.** The API is a Java API. Reader/writer round-trips between GeoJSON and JSTS geometry
  are boilerplate, and they are isolated in one `jsts.ts` per plugin for that reason.
- **Bad.** JSTS is not immune to bad input: `GeometryPrecisionReducer.reduce` can throw on a
  self-intersecting polygon. That is why the topology plugin runs its _structural_ rules
  (closed rings, duplicate vertices, self-intersection) first and **fails fast** — an unclosed
  ring makes every downstream JSTS answer either a crash or a lie, and the crash's stack trace
  blames the overlay rather than the import that produced the ring.
