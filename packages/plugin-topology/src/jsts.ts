/**
 * The JSTS boundary, and the projection sandwich around it.
 *
 * Two rules are enforced here rather than left to each rule to remember:
 *
 * 1. **JSTS is fed projected metres, never degrees** (core invariant 3). A boolean
 *    op is planar maths; run it on lng/lat and the "area" it returns is in square
 *    degrees, which is not a unit — it is a different unit at every latitude. A
 *    `0.001` tolerance in degrees is roughly 100 m. Everything crossing into JSTS
 *    goes through {@link projectGeometry} first and comes back through
 *    {@link unprojectXY}.
 *
 * 2. **Precision is reduced to the working CRS's grid before any boolean op.** Two
 *    coordinates 1e-12 m apart are the same corner to a surveyor and a different
 *    corner to an overlay operation, and that difference is precisely where slivers
 *    are born. {@link reduce} is not optional politeness; it is the difference
 *    between "these parcels share an edge" and "these parcels overlap by 4e-13 m²".
 *
 * Note the deep module paths. `jsts`'s package.json has no `main` and no
 * `exports`, so a bare `import 'jsts'` throws at runtime under ESM — and the deep
 * modules skip `monkey.js`, so `Geometry.prototype.intersection` and friends do not
 * exist. Hence the operation classes below.
 */

import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js'
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js'
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js'
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js'
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js'
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js'
import GeometryPrecisionReducer from 'jsts/org/locationtech/jts/precision/GeometryPrecisionReducer.js'
import Centroid from 'jsts/org/locationtech/jts/algorithm/Centroid.js'
import ConvexHull from 'jsts/org/locationtech/jts/algorithm/ConvexHull.js'

import type { Geometry, Position } from 'geojson'
import type { LngLat, ProjectedCrs, ProjectedXY } from '@blaeu/core'

/**
 * The slice of the JTS `Geometry` API this package actually uses.
 *
 * Deliberately minimal: every method here is one we call and have verified exists
 * on a deep-imported geometry (i.e. survives the absence of `monkey.js`).
 */
export interface JstsGeometry {
  getArea(): number
  getLength(): number
  isEmpty(): boolean
  getGeometryType(): string
  getNumGeometries(): number
  getGeometryN(n: number): JstsGeometry
  getCoordinates(): readonly JstsCoordinate[]
}

export interface JstsCoordinate {
  readonly x: number
  readonly y: number
}

/** What JSTS says is wrong with a geometry, and — crucially — where. */
export interface ValidityError {
  /** JSTS's own wording, e.g. `'Self-intersection'`. English; see `messages.ts`. */
  readonly message: string
  /** The offending coordinate, in the working CRS. Absent for a few error classes. */
  readonly at: ProjectedXY | undefined
}

const reader = new GeoJSONReader()
const writer = new GeoJSONWriter()

/* ------------------------------------------------------------------ *
 * Projection: the boundary between the store (4326) and JSTS (metres)
 * ------------------------------------------------------------------ */

/** Re-projects a whole geometry into the working CRS, in metres. */
export function projectGeometry(geometry: Geometry, plane: ProjectedCrs): Geometry {
  return mapPositions(geometry, (position) => {
    const [x, y] = plane.forward(toLngLat(position))
    return [x, y]
  })
}

/** The inverse of {@link projectGeometry}. */
export function unprojectGeometry(geometry: Geometry, plane: ProjectedCrs): Geometry {
  return mapPositions(geometry, (position) => {
    const [lng, lat] = plane.inverse(toXY(position))
    return [lng, lat]
  })
}

export function unprojectXY(xy: ProjectedXY, plane: ProjectedCrs): LngLat {
  return plane.inverse(xy)
}

/**
 * Rebuilds a geometry with every position passed through `fn`.
 *
 * Written out by hand rather than pulled from Turf because it must be *exactly*
 * structure-preserving: a projection that silently drops a hole, or reorders a
 * MultiPolygon's parts, changes which parcel a boolean op thinks it is looking at.
 */
function mapPositions(geometry: Geometry, fn: (position: Position) => Position): Geometry {
  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coordinates: fn(geometry.coordinates) }
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: geometry.coordinates.map(fn) }
    case 'LineString':
      return { type: 'LineString', coordinates: geometry.coordinates.map(fn) }
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: geometry.coordinates.map((l) => l.map(fn)) }
    case 'Polygon':
      return { type: 'Polygon', coordinates: geometry.coordinates.map((r) => r.map(fn)) }
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((p) => p.map((r) => r.map(fn))),
      }
    case 'GeometryCollection':
      return {
        type: 'GeometryCollection',
        geometries: geometry.geometries.map((g) => mapPositions(g, fn)),
      }
  }
}

/** `noUncheckedIndexedAccess` makes `position[0]` a `number | undefined`. Fail loudly, once, here. */
export function toLngLat(position: Position): LngLat {
  const lng = position[0]
  const lat = position[1]
  if (lng === undefined || lat === undefined) {
    throw new Error(
      `[topology] a position has fewer than two ordinates: ${JSON.stringify(position)}. ` +
        `Fix the geometry upstream — a partial coordinate cannot be projected, and guessing the ` +
        `missing ordinate would silently move a boundary.`,
    )
  }
  return [lng, lat]
}

function toXY(position: Position): ProjectedXY {
  const [x, y] = toLngLat(position)
  return [x, y]
}

/* ------------------------------------------------------------------ *
 * Crossing into JSTS
 * ------------------------------------------------------------------ */

/** Reads a **projected** GeoJSON geometry. Feeding this degrees is the bug this package exists to prevent. */
export function read(projected: Geometry): JstsGeometry {
  return reader.read(projected) as JstsGeometry
}

/** Writes a JSTS geometry back to GeoJSON — still projected; the caller un-projects. */
export function write(geometry: JstsGeometry): Geometry {
  return writer.write(geometry) as Geometry
}

/**
 * Snaps every coordinate to the CRS's precision grid (1 mm for cadastre).
 *
 * Run this on **both** operands before every boolean op. Reducing one and not the
 * other reintroduces exactly the mismatch it exists to remove.
 */
export function reduce(geometry: JstsGeometry, precisionMetres: number): JstsGeometry {
  // JTS's PrecisionModel is a *scale*, not a grid size: 1 mm ⇒ scale 1000.
  const model = new PrecisionModel(1 / precisionMetres)
  return GeometryPrecisionReducer.reduce(geometry, model) as JstsGeometry
}

export function intersection(a: JstsGeometry, b: JstsGeometry): JstsGeometry {
  return OverlayOp.overlayOp(a, b, OverlayOp.INTERSECTION) as JstsGeometry
}

export function union(a: JstsGeometry, b: JstsGeometry): JstsGeometry {
  return OverlayOp.overlayOp(a, b, OverlayOp.UNION) as JstsGeometry
}

export function difference(a: JstsGeometry, b: JstsGeometry): JstsGeometry {
  return OverlayOp.overlayOp(a, b, OverlayOp.DIFFERENCE) as JstsGeometry
}

export function convexHull(geometry: JstsGeometry): JstsGeometry {
  return new ConvexHull(geometry).getConvexHull() as JstsGeometry
}

/** Buffers by `distance` metres. The distance is metres because the geometry is projected — that is the whole discipline of this file. */
export function buffer(geometry: JstsGeometry, distanceMetres: number): JstsGeometry {
  return BufferOp.bufferOp(geometry, distanceMetres) as JstsGeometry
}

/**
 * `buffer(0)` — the classic self-intersection repair.
 *
 * It is *not* a lossless fix: on a bowtie it keeps both lobes as a MultiPolygon,
 * and on other self-intersections it can drop the smaller lobe outright, changing
 * the parcel's area. That is why nothing in this package calls it unless a human
 * asked (see `TopologyOptions.autoFix`).
 */
export function bufferZero(geometry: JstsGeometry): JstsGeometry {
  return BufferOp.bufferOp(geometry, 0) as JstsGeometry
}

/**
 * Validity, with a coordinate.
 *
 * The coordinate is the whole point. "Invalid geometry" on a 400-vertex parcel
 * boundary tells a surveyor nothing; "self-intersection at Y=458123.456
 * X=4421987.123" lets a UI zoom straight to it.
 *
 * Note: this runs on the geometry *as stored*, before precision reduction —
 * `GeometryPrecisionReducer` may throw on a self-intersecting polygon, and a
 * validity check that crashes on invalid input is not a validity check.
 */
export function validityError(geometry: JstsGeometry): ValidityError | undefined {
  const op = new IsValidOp(geometry)
  if (op.isValid() === true) return undefined

  const error: unknown = op.getValidationError()
  if (error === null || error === undefined) {
    return { message: 'Invalid geometry', at: undefined }
  }

  const typed = error as { getMessage(): string; getCoordinate(): JstsCoordinate | null }
  const coordinate = typed.getCoordinate()
  return {
    message: typed.getMessage(),
    at: coordinate ? [coordinate.x, coordinate.y] : undefined,
  }
}

/** The area-weighted centroid, in the working CRS. `undefined` for an empty geometry. */
export function centroid(geometry: JstsGeometry): ProjectedXY | undefined {
  if (geometry.isEmpty()) return undefined
  const coordinate = Centroid.getCentroid(geometry) as JstsCoordinate | null
  if (!coordinate || !Number.isFinite(coordinate.x) || !Number.isFinite(coordinate.y)) {
    return undefined
  }
  return [coordinate.x, coordinate.y]
}

/** Flattens a possibly-multi geometry into its parts. A `GeometryCollection` of one yields one. */
export function components(geometry: JstsGeometry): readonly JstsGeometry[] {
  const count = geometry.getNumGeometries()
  if (count <= 1) return geometry.isEmpty() ? [] : [geometry]

  const parts: JstsGeometry[] = []
  for (let i = 0; i < count; i++) {
    const part = geometry.getGeometryN(i)
    if (!part.isEmpty()) parts.push(part)
  }
  return parts
}

/** True if the two geometries share at least a point — including a boundary-only touch. */
export function touchesOrIntersects(a: JstsGeometry, b: JstsGeometry): boolean {
  return !intersection(a, b).isEmpty()
}
