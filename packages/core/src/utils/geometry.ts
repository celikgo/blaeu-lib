/**
 * Geometry primitives the store needs on ingest, and the planar maths the
 * spatial index needs to answer `nearest()` honestly.
 *
 * Two rules from `gis-geometry-precision` are implemented here and nowhere else,
 * so that they cannot be forgotten at a second entry point:
 *
 * 1. **Precision is reduced on ingest, once.** Everything downstream — the
 *    topology index, boolean ops, equality — may then assume coordinates sit on
 *    the working CRS's grid, and may compare them exactly.
 * 2. **Rings are wound RFC 7946 and closed.** A wrongly-wound hole is not a
 *    rendering artefact: it becomes a second exterior ring, and the parcel's area
 *    is then the *sum* rather than the difference. That number goes on a deed.
 */

import type { Geometry, Position } from 'geojson'
import type { Bbox, LngLat, ProjectedXY } from '../types/common.js'
import type { CrsService } from '../types/crs.js'

/** Enough of {@link CrsService} to normalise geometry. Keeps the helpers testable in isolation. */
export type Quantiser = Pick<CrsService, 'quantise'>

/**
 * Reads a GeoJSON position as a lng/lat pair, rejecting the shapes that would
 * otherwise render as *nothing at all* — the hardest failure to trace, because
 * there is no error, just an empty patch of map where a parcel should be.
 */
export function toLngLat(position: Position): LngLat {
  const lng = position[0]
  const lat = position[1]
  if (lng === undefined || lat === undefined || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new Error(
      `[blaeu] invalid coordinate ${JSON.stringify(position)}: expected a finite [lng, lat] pair. ` +
        `Check the source of this geometry — a NaN or missing ordinate renders as blank map, not as an error.`,
    )
  }
  return [lng, lat]
}

/** Exact 2D comparison. Only meaningful *after* quantisation — see the module doc. */
export function positionsEqual(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

/** Snaps to the working CRS's precision grid, preserving any elevation ordinate. */
export function quantisePosition(position: Position, crs: Quantiser): Position {
  const [lng, lat] = crs.quantise(toLngLat(position))
  const z = position[2]
  return z === undefined ? [lng, lat] : [lng, lat, z]
}

/** Drops consecutive duplicates. Nobody ever means to digitise the same corner twice. */
export function dedupeConsecutive(positions: readonly Position[]): Position[] {
  const out: Position[] = []
  for (const p of positions) {
    const last = out[out.length - 1]
    if (last !== undefined && positionsEqual(last, p)) continue
    out.push(p)
  }
  return out
}

export function isRingClosed(ring: readonly Position[]): boolean {
  const first = ring[0]
  const last = ring[ring.length - 1]
  return first !== undefined && last !== undefined && ring.length > 1 && positionsEqual(first, last)
}

/**
 * Twice the signed area (the shoelace sum). Positive is counter-clockwise.
 *
 * Computed on lng/lat, which is fine *for the sign*: the working projections are
 * conformal and orientation-preserving, so the winding is the same in either
 * space. The magnitude is meaningless — for a real area, project first
 * (`crs.area`), because a spherical area on a 2 000 m² parcel is wrong by square
 * metres.
 */
export function ringSignedArea2(ring: readonly Position[]): number {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!
    const b = ring[(i + 1) % ring.length]!
    sum += a[0]! * b[1]! - b[0]! * a[1]!
  }
  return sum
}

/**
 * Normalises one ring: quantise → dedupe → wind → close.
 *
 * @param exterior exterior rings are counter-clockwise, holes clockwise (RFC 7946 §3.1.6).
 * @param rewind when `false`, the winding step is skipped and the ring's coordinate
 *   **order is preserved**. This exists for one caller — a transient edit *preview* (see
 *   ADR 0011). During a vertex drag the tool addresses corners by positional index, and
 *   silently reversing a ring the instant its winding flips (a triangle's apex crossing
 *   its base) would leave those indices pointing at the wrong corners for every later
 *   frame of the gesture. Ingest and the durable commit both leave this `true`, so every
 *   *stored* feature that survives a gesture is still wound RFC 7946.
 */
export function normaliseRing(
  ring: readonly Position[],
  crs: Quantiser,
  exterior: boolean,
  where: string,
  rewind = true,
): Position[] {
  const quantised = ring.map((p) => quantisePosition(p, crs))
  const open = dedupeConsecutive(quantised)
  // Work on the open ring so the closing vertex can't be mistaken for a corner.
  if (isRingClosed(open)) open.pop()

  if (open.length < 3) {
    throw new Error(
      `[blaeu] ${where}: this ${exterior ? 'exterior ring' : 'hole'} collapsed to ${open.length} ` +
        `distinct corner(s) once snapped to the working CRS's precision grid, and a ring needs at least 3. ` +
        `The source geometry is either degenerate or is in a different CRS than you think.`,
    )
  }

  const area2 = ringSignedArea2(open)
  if (area2 === 0) {
    throw new Error(
      `[blaeu] ${where}: ring has zero area — its corners are collinear. ` +
        `Fix the source geometry; BlaeuMap will not guess at what shape was intended.`,
    )
  }

  const counterClockwise = area2 > 0
  if (rewind && counterClockwise !== exterior) open.reverse()

  return [...open, open[0]!]
}

/**
 * The ingest normaliser. Idempotent — feeding it its own output changes nothing,
 * which is what lets `undo` of a remove re-add the *identical* feature and lets
 * the round-trip test assert deep equality.
 *
 * Any `bbox` member on the input is dropped rather than recomputed: a stale bbox
 * that disagrees with the coordinates is worse than no bbox, and the spatial
 * index computes its own.
 */
export function normaliseGeometry(
  geometry: Geometry,
  crs: Quantiser,
  where = 'geometry',
  rewind = true,
): Geometry {
  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coordinates: quantisePosition(geometry.coordinates, crs) }

    case 'MultiPoint':
      if (geometry.coordinates.length === 0) throw emptyGeometry(where, 'MultiPoint', 'points')
      return {
        type: 'MultiPoint',
        coordinates: geometry.coordinates.map((p) => quantisePosition(p, crs)),
      }

    case 'LineString':
      return { type: 'LineString', coordinates: normaliseLine(geometry.coordinates, crs, where) }

    case 'MultiLineString':
      if (geometry.coordinates.length === 0) throw emptyGeometry(where, 'MultiLineString', 'lines')
      return {
        type: 'MultiLineString',
        coordinates: geometry.coordinates.map((line, i) =>
          normaliseLine(line, crs, `${where} part ${i}`),
        ),
      }

    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: normalisePolygon(geometry.coordinates, crs, where, rewind),
      }

    case 'MultiPolygon':
      if (geometry.coordinates.length === 0) throw emptyGeometry(where, 'MultiPolygon', 'polygons')
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((poly, i) =>
          normalisePolygon(poly, crs, `${where} part ${i}`, rewind),
        ),
      }

    case 'GeometryCollection':
      if (geometry.geometries.length === 0) {
        throw emptyGeometry(where, 'GeometryCollection', 'geometries')
      }
      return {
        type: 'GeometryCollection',
        geometries: geometry.geometries.map((g, i) =>
          normaliseGeometry(g, crs, `${where} member ${i}`, rewind),
        ),
      }
  }
}

/**
 * An empty multi-geometry or geometry collection has no shape at all, so it cannot be
 * indexed, given a bbox, styled, or clicked. Reject it here — the one geometry gate — so
 * a store write cannot pass this normaliser and then throw later in `geometryBbox` deep
 * inside `_put`, which would leave a batch write half-applied.
 */
function emptyGeometry(where: string, type: string, part: string): Error {
  return new Error(
    `[blaeu] ${where}: this ${type} is empty — it contains no ${part}. ` +
      `An empty geometry has no position to index or draw; remove the feature instead of ` +
      `giving it a shape with nothing in it.`,
  )
}

function normaliseLine(line: readonly Position[], crs: Quantiser, where: string): Position[] {
  const out = dedupeConsecutive(line.map((p) => quantisePosition(p, crs)))
  if (out.length < 2) {
    throw new Error(
      `[blaeu] ${where}: line collapsed to ${out.length} distinct vertex(es) after snapping to the ` +
        `precision grid. A LineString needs at least 2.`,
    )
  }
  return out
}

function normalisePolygon(
  rings: readonly (readonly Position[])[],
  crs: Quantiser,
  where: string,
  rewind = true,
): Position[][] {
  if (rings.length === 0) {
    throw new Error(`[blaeu] ${where}: polygon has no rings.`)
  }
  return rings.map((ring, i) => normaliseRing(ring, crs, i === 0, `${where} ring ${i}`, rewind))
}

/**
 * Visits every *corner* of a geometry, addressed the way {@link VertexRef} does.
 *
 * The closing vertex of a polygon ring is **not** visited: it is the same corner
 * as index 0, and counting it twice would make the topology index report every
 * lone polygon's first corner as "shared" — with itself.
 *
 * `GeometryCollection` is skipped, because `VertexRef` has no way to address
 * "member 2 of the collection" and inventing one here would leak an addressing
 * scheme the rest of the library doesn't share.
 */
export function eachVertex(
  geometry: Geometry,
  visit: (part: number, ring: number, index: number, position: Position) => void,
): void {
  switch (geometry.type) {
    case 'Point':
      visit(0, 0, 0, geometry.coordinates)
      return

    case 'MultiPoint':
      geometry.coordinates.forEach((p, part) => visit(part, 0, 0, p))
      return

    case 'LineString':
      geometry.coordinates.forEach((p, index) => visit(0, 0, index, p))
      return

    case 'MultiLineString':
      geometry.coordinates.forEach((line, part) =>
        line.forEach((p, index) => visit(part, 0, index, p)),
      )
      return

    case 'Polygon':
      eachPolygonVertex(geometry.coordinates, 0, visit)
      return

    case 'MultiPolygon':
      geometry.coordinates.forEach((poly, part) => eachPolygonVertex(poly, part, visit))
      return

    case 'GeometryCollection':
      return
  }
}

function eachPolygonVertex(
  rings: readonly (readonly Position[])[],
  part: number,
  visit: (part: number, ring: number, index: number, position: Position) => void,
): void {
  rings.forEach((ring, ringIndex) => {
    const corners = isRingClosed(ring) ? ring.length - 1 : ring.length
    for (let i = 0; i < corners; i++) visit(part, ringIndex, i, ring[i]!)
  })
}

/** Every position, closing vertices included. Used for bounds, where duplicates are harmless. */
export function eachPosition(geometry: Geometry, visit: (position: Position) => void): void {
  switch (geometry.type) {
    case 'Point':
      visit(geometry.coordinates)
      return
    case 'MultiPoint':
    case 'LineString':
      geometry.coordinates.forEach(visit)
      return
    case 'MultiLineString':
    case 'Polygon':
      geometry.coordinates.forEach((part) => part.forEach(visit))
      return
    case 'MultiPolygon':
      geometry.coordinates.forEach((poly) => poly.forEach((ring) => ring.forEach(visit)))
      return
    case 'GeometryCollection':
      geometry.geometries.forEach((g) => eachPosition(g, visit))
      return
  }
}

/** `[west, south, east, north]`, in 4326. Does not handle antimeridian crossing. */
export function geometryBbox(geometry: Geometry): Bbox {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity

  eachPosition(geometry, (p) => {
    const [lng, lat] = toLngLat(p)
    if (lng < west) west = lng
    if (lng > east) east = lng
    if (lat < south) south = lat
    if (lat > north) north = lat
  })

  if (west === Infinity) {
    throw new Error(
      `[blaeu] cannot compute a bbox for an empty ${geometry.type}. ` +
        `A feature with no coordinates cannot be indexed, styled, or clicked — reject it upstream.`,
    )
  }
  return [west, south, east, north]
}

/* ------------------------------------------------------------------ *
 * Planar maths. Everything below is in the working CRS, in metres.
 * ------------------------------------------------------------------ */

export function planarDistance(a: ProjectedXY, b: ProjectedXY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/** Shortest distance from `p` to the segment `a`–`b`, in metres. */
export function distanceToSegment(p: ProjectedXY, a: ProjectedXY, b: ProjectedXY): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return planarDistance(p, a)

  // Projection parameter, clamped to the segment: an unclamped t makes the
  // "nearest point on the line", which is not on the parcel boundary at all.
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return planarDistance(p, [a[0] + t * dx, a[1] + t * dy])
}

/** Even-odd ray cast. Points exactly on the boundary are undefined-but-harmless — the caller is measuring a distance that is already ~0. */
export function pointInRing(p: ProjectedXY, ring: readonly ProjectedXY[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!
    const b = ring[j]!
    const intersects =
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] || Number.EPSILON) + a[0]
    if (intersects) inside = !inside
  }
  return inside
}

/**
 * Distance from a point to a geometry, in **metres**, computed in the working
 * plane — not on a sphere, and not in degrees.
 *
 * A point inside a polygon (and outside its holes) is at distance 0. That is what
 * makes `collection.nearest()` usable as a hit test as well as a proximity query.
 */
export function distanceToGeometryMetres(
  crs: Pick<CrsService, 'working'>,
  point: LngLat,
  geometry: Geometry,
): number {
  const plane = crs.working
  const p = plane.forward(point)
  const project = (ring: readonly Position[]): ProjectedXY[] =>
    ring.map((position) => plane.forward(toLngLat(position)))

  const toPath = (path: readonly Position[]): number => {
    const xy = project(path)
    if (xy.length === 1) return planarDistance(p, xy[0]!)
    let best = Infinity
    for (let i = 0; i < xy.length - 1; i++) {
      const d = distanceToSegment(p, xy[i]!, xy[i + 1]!)
      if (d < best) best = d
    }
    return best
  }

  const toPolygon = (rings: readonly (readonly Position[])[]): number => {
    const projected = rings.map(project)
    const outer = projected[0]
    if (outer === undefined) return Infinity

    if (pointInRing(p, outer)) {
      const inHole = projected.slice(1).some((hole) => pointInRing(p, hole))
      if (!inHole) return 0
    }
    let best = Infinity
    for (const ring of projected) {
      for (let i = 0; i < ring.length - 1; i++) {
        const d = distanceToSegment(p, ring[i]!, ring[i + 1]!)
        if (d < best) best = d
      }
    }
    return best
  }

  switch (geometry.type) {
    case 'Point':
      return planarDistance(p, plane.forward(toLngLat(geometry.coordinates)))
    case 'MultiPoint':
      return Math.min(
        ...geometry.coordinates.map((c) => planarDistance(p, plane.forward(toLngLat(c)))),
      )
    case 'LineString':
      return toPath(geometry.coordinates)
    case 'MultiLineString':
      return Math.min(...geometry.coordinates.map(toPath))
    case 'Polygon':
      return toPolygon(geometry.coordinates)
    case 'MultiPolygon':
      return Math.min(...geometry.coordinates.map(toPolygon))
    case 'GeometryCollection':
      return Math.min(
        ...geometry.geometries.map((g) => distanceToGeometryMetres(crs, point, g)),
        Infinity,
      )
  }
}

/**
 * A lng/lat bbox that contains every point within `radiusMetres` of `centre`.
 *
 * Built by projecting, offsetting in metres, and un-projecting the corners —
 * rather than the usual `radius / 111320` degree fudge, which is wrong by the
 * cosine of the latitude and turns a 10 m snap tolerance into a 13 m one in
 * northern Europe.
 */
export function bboxAround(
  crs: Pick<CrsService, 'working'>,
  centre: LngLat,
  radiusMetres: number,
): Bbox {
  const plane = crs.working
  const [x, y] = plane.forward(centre)
  const corners: ProjectedXY[] = [
    [x - radiusMetres, y - radiusMetres],
    [x + radiusMetres, y - radiusMetres],
    [x + radiusMetres, y + radiusMetres],
    [x - radiusMetres, y + radiusMetres],
  ]

  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const corner of corners) {
    const [lng, lat] = plane.inverse(corner)
    if (lng < west) west = lng
    if (lng > east) east = lng
    if (lat < south) south = lat
    if (lat > north) north = lat
  }
  return [west, south, east, north]
}
