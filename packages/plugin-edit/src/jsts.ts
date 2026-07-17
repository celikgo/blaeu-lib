/**
 * The boolean operations behind `split` and `merge`, done with JSTS, in the
 * projected working CRS.
 *
 * Why JSTS and not Turf: `@turf/union` and friends are floating-point boolean ops
 * with no precision model, and on two parcels that share an edge they produce
 * spikes and slivers — a sub-millimetre strip of land between two parcels that a
 * surveyor drew as touching. JSTS nodes properly and tells you when it cannot.
 * (`gis-geometry-precision`, "choosing the library".)
 *
 * Why in the plane: the ops themselves are topological and would "work" on
 * degrees, but the numbers that come out — the area of each half of a split parcel
 * — go on a deed. So everything here is projected to metres on the way in and
 * un-projected on the way out, and nothing in between knows what a longitude is.
 *
 * The imports are deep on purpose: `jsts` publishes no `main`/`exports`, so a bare
 * `import 'jsts'` resolves to nothing at runtime. See `jsts-modules.d.ts`.
 */

import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js'
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js'
import BoundaryOp from 'jsts/org/locationtech/jts/operation/BoundaryOp.js'
import UnionOp from 'jsts/org/locationtech/jts/operation/union/UnionOp.js'
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js'
import RelateOp from 'jsts/org/locationtech/jts/operation/relate/RelateOp.js'
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js'
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js'

import type { Geometry, LineString, ProjectedCrs } from '@blaeu/core'
import { mapPositions } from './geometry.js'

const reader = new GeoJSONReader()
const writer = new GeoJSONWriter()

/**
 * The sliver of JTS's `Geometry` this package actually touches.
 *
 * Declared here rather than typed in `jsts-modules.d.ts` because the *statics*
 * (`UnionOp.union`, …) are genuinely untyped and hand back `any`; naming what we
 * expect back from them is the difference between a typo failing here and failing
 * inside a boolean op three calls later.
 */
interface JstsGeometry {
  isEmpty(): boolean
  getDimension(): number
  getGeometryType(): string
  getFactory(): { createPoint(coordinate: unknown): JstsGeometry }
}

/**
 * Cuts `geometry` with `line` and returns the parts, in 4326.
 *
 * The method is the standard one: take the polygon's boundary, union it with the
 * cut line (which *nodes* the two — every crossing becomes a shared endpoint), and
 * polygonize the resulting arrangement. Then keep only the faces whose interior
 * lies inside the original, which is what drops the polygon's own holes: they come
 * back out of the polygonizer as perfectly good faces, and adding them to a
 * cadastral parcel would fill in the courtyard.
 *
 * Throws when the line does not fully cross the polygon. That is deliberate. A cut
 * that stops halfway produces exactly one face — the original — and returning it
 * would tell the surveyor the split "worked" while nothing had changed.
 */
export function splitPolygon(
  geometry: Geometry,
  line: LineString,
  plane: ProjectedCrs,
): Geometry[] {
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
    throw new Error(
      `[blaeu/edit] split expects a Polygon or MultiPolygon, got a ${geometry.type}. ` +
        `Cutting a line into pieces is a different operation — remove it and draw the pieces.`,
    )
  }
  if (line.coordinates.length < 2) {
    throw new Error(
      `[blaeu/edit] the split line needs at least two points. Click at least twice before finishing the cut.`,
    )
  }

  const target = read(geometry, plane)
  const cut = read(line, plane)

  const noded = UnionOp.union(BoundaryOp.getBoundary(target), cut)
  const polygonizer = new Polygonizer()
  polygonizer.add(noded)

  const faces = toArray(polygonizer.getPolygons())
  const inside = faces.filter((face) => {
    const point = face.getFactory().createPoint(InteriorPointArea.getInteriorPoint(face))
    return RelateOp.relate(target, point).isContains() === true
  })

  if (inside.length < 2) {
    throw new Error(
      `[blaeu/edit] the split line does not cut this feature in two: it produced ${inside.length} ` +
        `part(s). The line must cross the boundary at least twice — start it outside the parcel and ` +
        `end it outside. Nothing has been changed.`,
    )
  }

  return inside.map((face) => unread(face, plane))
}

/**
 * Unions the geometries into one, in 4326.
 *
 * Rejects a non-contiguous input. Two parcels that merely sit near each other union
 * into a `MultiPolygon`, and quietly writing that back as one parcel is worse than
 * refusing: it is a legal object — a single parcel — describing two disjoint pieces
 * of land, and nothing downstream will ever question it. Touching at a single corner
 * does not count either; contiguity means a shared *edge* (an intersection of
 * dimension 1).
 */
export function mergePolygons(geometries: readonly Geometry[], plane: ProjectedCrs): Geometry {
  if (geometries.length < 2) {
    throw new Error(`[blaeu/edit] merge needs at least two features, got ${geometries.length}.`)
  }
  for (const geometry of geometries) {
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
      throw new Error(
        `[blaeu/edit] merge expects polygons, got a ${geometry.type}. Merging a line into a parcel is not defined.`,
      )
    }
  }

  const parts = geometries.map((geometry) => read(geometry, plane))
  assertContiguous(parts)

  let union: JstsGeometry = parts[0]!
  for (let i = 1; i < parts.length; i++) union = UnionOp.union(union, parts[i]) as JstsGeometry

  if (union.getGeometryType() !== 'Polygon') {
    // Belt and braces: the contiguity graph above should have caught this. If JSTS
    // still hands back a MultiPolygon, the inputs touch in a way that leaves a hole
    // or a pinch, and the surveyor needs to know rather than to inherit it.
    throw new Error(
      `[blaeu/edit] merging these features produces a ${union.getGeometryType()}, not a single parcel. ` +
        `They touch, but not along a shared edge — check for a sliver or a gap between them first.`,
    )
  }

  return unread(union, plane)
}

/**
 * Every input must be reachable from every other through shared edges.
 *
 * A pairwise check is not enough: A–B and C–D touching, with the two pairs apart,
 * would pass "everything touches something". So this is a connectivity walk over
 * the adjacency graph — the same question a cadastral registry asks of a proposed
 * merge.
 */
function assertContiguous(parts: readonly JstsGeometry[]): void {
  const adjacency: number[][] = parts.map(() => [])

  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const shared = OverlayOp.intersection(parts[i], parts[j]) as JstsGeometry
      // Dimension 1 is a shared edge; 0 is a corner touch; -1 is empty. Only an
      // edge makes two parcels neighbours in the sense a merge means.
      if (!shared.isEmpty() && shared.getDimension() >= 1) {
        adjacency[i]!.push(j)
        adjacency[j]!.push(i)
      }
    }
  }

  const seen = new Set<number>([0])
  const queue = [0]
  while (queue.length > 0) {
    const node = queue.pop()!
    for (const next of adjacency[node] ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }

  if (seen.size !== parts.length) {
    throw new Error(
      `[blaeu/edit] refusing to merge: ${parts.length - seen.size} of the ${parts.length} selected ` +
        `features do not share an edge with the rest. Merging disjoint parcels would produce one parcel ` +
        `made of two pieces of land, which is almost never what was meant. Nothing has been changed.`,
    )
  }
}

/* ------------------------------------------------------------------------- */
/* The projection boundary. Everything above this line is in metres.         */
/* ------------------------------------------------------------------------- */

function read(geometry: Geometry, plane: ProjectedCrs): JstsGeometry {
  // `ProjectedXY` and `LngLat` are the same tuple shape, so this reads as a no-op
  // to the type system — the discipline is in the naming, and in the fact that only
  // these two functions cross the boundary.
  return reader.read(mapPositions(geometry, (lngLat) => plane.forward(lngLat))) as JstsGeometry
}

function unread(geometry: JstsGeometry, plane: ProjectedCrs): Geometry {
  const out = writer.write(geometry) as Geometry
  return mapPositions(out, (xy) => plane.inverse(xy))
}

/** JTS collections are Java-shaped: `size()` / `get(i)`, not iterable. */
function toArray(collection: { size(): number; get(index: number): JstsGeometry }): JstsGeometry[] {
  const out: JstsGeometry[] = []
  for (let i = 0; i < collection.size(); i++) out.push(collection.get(i))
  return out
}
