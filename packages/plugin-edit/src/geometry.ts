/**
 * Vertex addressing, and the planar transforms behind move/rotate/scale.
 *
 * Two rules govern everything in this file.
 *
 * **Addressing.** A vertex is a {@link VertexRef} — `part`/`ring`/`index` — and
 * the *closing* coordinate of a polygon ring is not a vertex: it is a repeat of
 * index 0. Every edit here maintains that invariant, because a ring whose first
 * and last coordinates have drifted apart is a ring that JSTS will call invalid
 * three operations later, at a call site that has nothing to do with the edit
 * that broke it.
 *
 * **Precision.** Anything a surveyor signs — rotate, scale, move, a distance —
 * happens in the projected working CRS, in metres, via
 * {@link transformInPlane} (core invariant 3). Nothing in this file does
 * trigonometry on degrees.
 */

import type { Geometry, LngLat, Position, ProjectedCrs, ProjectedXY, VertexRef } from '@blaeu/core'

/** A polygon ring is stored closed; a line is not. This decides whether index 0 has a twin at the end. */
export function hasClosedRings(geometry: Geometry): boolean {
  return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon'
}

/**
 * The coordinate array a {@link VertexRef} points into, or `undefined` if the
 * geometry has no such ring.
 *
 * Returns the *live* array of whatever geometry it is handed. Callers that intend
 * to edit hand it a clone; the store's copy is frozen in strict mode, so a caller
 * who forgets gets an exception rather than a silently desynced renderer.
 */
export function ringOf(geometry: Geometry, part: number, ring: number): Position[] | undefined {
  switch (geometry.type) {
    case 'LineString':
      return part === 0 && ring === 0 ? geometry.coordinates : undefined
    case 'MultiLineString':
      return ring === 0 ? geometry.coordinates[part] : undefined
    case 'Polygon':
      return part === 0 ? geometry.coordinates[ring] : undefined
    case 'MultiPolygon':
      return geometry.coordinates[part]?.[ring]
    default:
      return undefined
  }
}

/** Visits every editable ring. Points, MultiPoints and GeometryCollections have none. */
export function eachRing(
  geometry: Geometry,
  visit: (part: number, ring: number, positions: readonly Position[]) => void,
): void {
  switch (geometry.type) {
    case 'LineString':
      visit(0, 0, geometry.coordinates)
      return
    case 'MultiLineString':
      geometry.coordinates.forEach((line, part) => visit(part, 0, line))
      return
    case 'Polygon':
      geometry.coordinates.forEach((ring, index) => visit(0, index, ring))
      return
    case 'MultiPolygon':
      geometry.coordinates.forEach((polygon, part) =>
        polygon.forEach((ring, index) => visit(part, index, ring)),
      )
      return
    default:
      return
  }
}

/** Corners in a ring — the closing coordinate excluded, because it is not a corner. */
export function cornerCount(positions: readonly Position[], closed: boolean): number {
  return closed ? Math.max(positions.length - 1, 0) : positions.length
}

/**
 * The fewest corners this geometry may have and still be that geometry: 3 for a
 * polygon ring, 2 for a line. `override` may raise the floor (a preset may demand
 * 4-corner parcels) but never lower it — a 2-corner "polygon" is not a shape, and
 * the store would reject it on the next write anyway, from a stack frame that
 * gives the user no idea which vertex they deleted.
 */
export function minimumCorners(geometry: Geometry, override: number | undefined): number {
  const floor = hasClosedRings(geometry) ? 3 : 2
  return override === undefined ? floor : Math.max(floor, override)
}

/**
 * Moves every listed vertex to `to`, on a copy.
 *
 * `to` is **absolute**, not a delta, and that is the point: during a drag this is
 * called once per `pointermove` with the pointer's current position, so the result
 * depends only on the original geometry and where the pointer is now. Applying a
 * per-frame delta instead would compound 200 rounding errors over a 200-frame drag
 * and land the vertex somewhere the user did not drop it. (Same reason
 * `MoveVerticesCommand` stores `from` and `to` rather than a delta.)
 */
export function withVerticesMoved(
  geometry: Geometry,
  refs: readonly VertexRef[],
  to: LngLat,
): Geometry {
  const next = structuredClone(geometry) as Geometry
  const closed = hasClosedRings(next)

  for (const ref of refs) {
    const positions = ringOf(next, ref.part, ref.ring)
    if (positions === undefined || positions[ref.index] === undefined) {
      throw new Error(
        `[blaeu/edit] no vertex at part ${ref.part}, ring ${ref.ring}, index ${ref.index} of ` +
          `"${ref.feature}" (a ${geometry.type}). The reference is stale — rebuild the handles after ` +
          `every geometry change rather than caching them across an edit.`,
      )
    }
    positions[ref.index] = [to[0], to[1]]
    // The closing coordinate is the same corner as index 0. Move one without the
    // other and the ring is open — which every library handles differently and
    // none handle well.
    if (closed && ref.index === 0) positions[positions.length - 1] = [to[0], to[1]]
  }
  return next
}

/** Inserts `at` so that it becomes the vertex with index `index`. */
export function withVertexInserted(
  geometry: Geometry,
  part: number,
  ring: number,
  index: number,
  at: LngLat,
): Geometry {
  const next = structuredClone(geometry) as Geometry
  const positions = ringOf(next, part, ring)
  if (positions === undefined) {
    throw new Error(
      `[blaeu/edit] cannot insert a vertex into part ${part}, ring ${ring} of a ${geometry.type}: no such ring.`,
    )
  }
  positions.splice(index, 0, [at[0], at[1]])
  return next
}

/**
 * Removes a corner, keeping the ring closed.
 *
 * Throws — rather than returning a degenerate shape — when the ring would fall
 * below `minimum`. A polygon with two corners is not a polygon that renders badly;
 * it is not a polygon.
 */
export function withVertexRemoved(
  geometry: Geometry,
  part: number,
  ring: number,
  index: number,
  minimum: number,
): Geometry {
  const next = structuredClone(geometry) as Geometry
  const positions = ringOf(next, part, ring)
  if (positions === undefined || positions[index] === undefined) {
    throw new Error(
      `[blaeu/edit] cannot delete the vertex at part ${part}, ring ${ring}, index ${index} of a ` +
        `${geometry.type}: no such vertex.`,
    )
  }

  const closed = hasClosedRings(next)
  const corners = cornerCount(positions, closed)
  if (corners <= minimum) {
    throw new Error(
      `[blaeu/edit] refusing to delete this vertex: the ring would be left with ${corners - 1} ` +
        `corner(s) and needs at least ${minimum}. Delete the whole feature instead, or add a vertex first.`,
    )
  }

  positions.splice(index, 1)
  if (closed) {
    // Removing index 0 leaves the *old* first corner as the closing coordinate.
    // Re-close on the new first corner, or the ring describes a shape that does
    // not exist.
    const first = positions[0]
    if (first !== undefined) positions[positions.length - 1] = [first[0] ?? 0, first[1] ?? 0]
  }
  return next
}

/* ========================================================================= */
/* The projection sandwich: 4326 → metres → maths → 4326                     */
/* ========================================================================= */

/**
 * Rewrites every coordinate of `geometry` through `fn`, in the **working plane**.
 *
 * This is the sandwich from `gis-geometry-precision`, in one function, so that no
 * caller in this package is ever tempted to rotate a shape by doing trigonometry
 * on longitudes. (A "2 metre" translation applied to degrees is a 220 km
 * translation, and it renders without complaint — which is why it survives review.)
 */
export function transformInPlane(
  geometry: Geometry,
  plane: ProjectedCrs,
  fn: (xy: ProjectedXY) => ProjectedXY,
): Geometry {
  return mapPositions(geometry, (lngLat) => plane.inverse(fn(plane.forward(lngLat))))
}

export function mapPositions(geometry: Geometry, fn: (lngLat: LngLat) => LngLat): Geometry {
  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coordinates: applyTo(geometry.coordinates, fn) }
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: geometry.coordinates.map((p) => applyTo(p, fn)) }
    case 'LineString':
      return { type: 'LineString', coordinates: geometry.coordinates.map((p) => applyTo(p, fn)) }
    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: geometry.coordinates.map((line) => line.map((p) => applyTo(p, fn))),
      }
    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: geometry.coordinates.map((ring) => ring.map((p) => applyTo(p, fn))),
      }
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map((p) => applyTo(p, fn))),
        ),
      }
    case 'GeometryCollection':
      return {
        type: 'GeometryCollection',
        geometries: geometry.geometries.map((g) => mapPositions(g, fn)),
      }
  }
}

/** Translation by a metric delta, in the plane. */
export function translation(dx: number, dy: number): (xy: ProjectedXY) => ProjectedXY {
  return ([x, y]) => [x + dx, y + dy]
}

/** Rotation about a pivot, degrees clockwise (the surveyor's sense, matching `crs.bearing`). */
export function rotation(pivot: ProjectedXY, degrees: number): (xy: ProjectedXY) => ProjectedXY {
  // Negated because screen/grid rotation is measured clockwise while the maths
  // convention is counter-clockwise. Getting this wrong mirrors the parcel.
  const radians = (-degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return ([x, y]) => {
    const dx = x - pivot[0]
    const dy = y - pivot[1]
    return [pivot[0] + dx * cos - dy * sin, pivot[1] + dx * sin + dy * cos]
  }
}

/** Uniform scale about a pivot. */
export function scaling(pivot: ProjectedXY, factor: number): (xy: ProjectedXY) => ProjectedXY {
  return ([x, y]) => [pivot[0] + (x - pivot[0]) * factor, pivot[1] + (y - pivot[1]) * factor]
}

export interface PlanarBounds {
  readonly min: ProjectedXY
  readonly max: ProjectedXY
  /**
   * The pivot every transform defaults to.
   *
   * The centre of the bounding box, not the area centroid: a transform gizmo is a
   * *box*, and a user dragging its corner expects it to pivot about the middle of
   * the box they can see — not about a centroid that, for an L-shaped parcel, sits
   * somewhere they cannot point at.
   */
  readonly centre: ProjectedXY
}

/** Bounds of one or more geometries, in the working plane, in metres. */
export function planarBounds(
  geometries: readonly Geometry[],
  plane: ProjectedCrs,
): PlanarBounds | undefined {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const geometry of geometries) {
    mapPositions(geometry, (lngLat) => {
      const [x, y] = plane.forward(lngLat)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      return lngLat
    })
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined
  return {
    min: [minX, minY],
    max: [maxX, maxY],
    centre: [(minX + maxX) / 2, (minY + maxY) / 2],
  }
}

/** Midpoint of a segment, computed in the plane — the midpoint of two degrees is not the middle of the edge. */
export function planarMidpoint(a: LngLat, b: LngLat, plane: ProjectedCrs): LngLat {
  const [ax, ay] = plane.forward(a)
  const [bx, by] = plane.forward(b)
  return plane.inverse([(ax + bx) / 2, (ay + by) / 2])
}

export function toLngLat(position: Position): LngLat {
  const lng = position[0]
  const lat = position[1]
  if (lng === undefined || lat === undefined) {
    throw new Error(
      `[blaeu/edit] met a coordinate with fewer than two ordinates: ${JSON.stringify(position)}.`,
    )
  }
  return [lng, lat]
}

function applyTo(position: Position, fn: (lngLat: LngLat) => LngLat): Position {
  const [lng, lat] = fn(toLngLat(position))
  // The elevation ordinate rides along untouched: a planar transform has nothing
  // to say about height, and silently dropping it loses survey data.
  const z = position[2]
  return z === undefined ? [lng, lat] : [lng, lat, z]
}
