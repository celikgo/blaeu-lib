import { distanceXY, toLngLat } from '@blaeu/core'
import type { CrsService, LngLat, Polygon, Position, ProjectedXY } from '@blaeu/core'

/**
 * Marks a polygon that is really a circle, so an editor can recognise one.
 *
 * GeoJSON has no circle. A circle therefore ships as an approximating polygon — and the
 * moment it does, the centre and the radius the surveyor actually typed are gone, and any
 * later "edit the radius" has to re-derive them from the vertices and gets them slightly
 * wrong. Stashing the true parameters in `properties` keeps the round-trip lossless: the
 * polygon is what renders and what a topology check sees; these three fields are what a
 * re-edit reads.
 */
export const CIRCLE_SHAPE_PROPERTY = 'draw:shape'
export const CIRCLE_CENTRE_PROPERTY = 'draw:centre'
export const CIRCLE_RADIUS_PROPERTY = 'draw:radiusMetres'
export const CIRCLE_SEGMENTS_PROPERTY = 'draw:segments'

/**
 * The axis-aligned rectangle through two opposite corners — axis-aligned **in the working
 * CRS**.
 *
 * Doing it the obvious way, by holding lng and lat constant, does not produce a rectangle
 * on the ground: a metre of longitude is shorter at the top of the shape than at the
 * bottom, so the "rectangle" is a trapezoid whose sides are not parallel and whose corners
 * are not 90°. At 39°N over a 200 m shape that is centimetres — small, and exactly the
 * kind of small that a land registry rejects. So the corners are built in the projected
 * plane, where "axis-aligned" means what a surveyor means by it, and projected back.
 *
 * The ring is returned counter-clockwise and closed; the store re-normalises anyway, but a
 * function that hands back a half-formed ring invites a caller to use it raw.
 */
export function rectanglePolygon(crs: CrsService, a: LngLat, b: LngLat): Polygon {
  const plane = crs.working
  const [x1, y1] = plane.forward(a)
  const [x2, y2] = plane.forward(b)

  const corners: readonly ProjectedXY[] = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ]
  const ring: Position[] = corners.map((xy) => [...plane.inverse(xy)])
  ring.push([...ring[0]!])

  return { type: 'Polygon', coordinates: [ring] }
}

/** True when two corners are too close, in the plane, to make a rectangle with area. */
export function degenerateRectangle(crs: CrsService, a: LngLat, b: LngLat): boolean {
  const plane = crs.working
  const [x1, y1] = plane.forward(a)
  const [x2, y2] = plane.forward(b)
  // The precision grid is the honest threshold: a rectangle thinner than one quantisation
  // step collapses to a line the moment the store ingests it, and `normaliseRing` would
  // (rightly) throw on the zero-area result.
  const grid = plane.precision
  return Math.abs(x2 - x1) < grid || Math.abs(y2 - y1) < grid
}

/** Planar distance in metres between two geographic points, in the working CRS. */
export function radiusMetres(crs: CrsService, centre: LngLat, edge: LngLat): number {
  const plane = crs.working
  return distanceXY(plane.forward(centre), plane.forward(edge))
}

/**
 * A circle of `radius` metres about `centre`, approximated as a polygon.
 *
 * Built in the projected plane, not with `@turf/circle`: Turf's circle is a *geodesic*
 * circle on a sphere, so its radius is a great-circle distance, while the radius a surveyor
 * dimensions and the radius this tool reports are both planar distances in the working CRS.
 * The two differ, and a circle whose drawn radius does not match its stated radius is a
 * defect you find in court rather than in review.
 */
export function circlePolygon(
  crs: CrsService,
  centre: LngLat,
  radius: number,
  segments: number,
): Polygon {
  const plane = crs.working
  const [cx, cy] = plane.forward(centre)
  const n = Math.max(3, Math.floor(segments))

  const ring: Position[] = []
  for (let i = 0; i < n; i++) {
    // Counter-clockwise, matching RFC 7946's exterior-ring winding, so the store's
    // normaliser has nothing to reverse.
    const angle = (2 * Math.PI * i) / n
    ring.push([...plane.inverse([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)])])
  }
  ring.push([...ring[0]!])

  return { type: 'Polygon', coordinates: [ring] }
}

/** Reads a circle's true centre back off a feature's properties. `undefined` if it isn't one. */
export function circleCentre(properties: Readonly<Record<string, unknown>>): LngLat | undefined {
  const raw = properties[CIRCLE_CENTRE_PROPERTY]
  if (!Array.isArray(raw) || raw.length < 2) return undefined
  const [lng, lat] = raw
  if (typeof lng !== 'number' || typeof lat !== 'number') return undefined
  return toLngLat([lng, lat])
}
