import { eachPosition, geometryBbox, toLngLat } from '@fleximap/core'
import type { Bbox, Geometry, LngLat, Position, ScreenPoint } from '@fleximap/core'

/**
 * A representative interior-ish point for a feature, in 4326.
 *
 * This is what the lasso tests against, and it is deliberately *not* survey maths
 * (core invariant 3): a selection is cosmetic. Nothing a surveyor signs is derived
 * from it, so projecting 50 000 features into the working plane on pointer-up to
 * gain a centimetre of accuracy in a hit test would be a cost with no payer.
 *
 * Returns `undefined` for an empty geometry — a feature with no coordinates cannot
 * be inside a lasso, and pretending it sits at [0, 0] would put it in the Gulf of
 * Guinea.
 */
export function centroidOf(geometry: Geometry): LngLat | undefined {
  switch (geometry.type) {
    case 'Point':
      return toLngLat(geometry.coordinates)

    case 'Polygon':
      return ringCentroid(geometry.coordinates[0]) ?? averagePosition(geometry)

    case 'MultiPolygon': {
      // The largest part, not the average of the parts: the mean of an archipelago
      // is open water, and a lasso drawn around the main island would then miss it.
      let best: LngLat | undefined
      let bestArea = -1
      for (const part of geometry.coordinates) {
        const ring = part[0]
        if (ring === undefined) continue
        const area = Math.abs(signedArea2(ring))
        if (area <= bestArea) continue
        const centre = ringCentroid(ring)
        if (centre === undefined) continue
        bestArea = area
        best = centre
      }
      return best ?? averagePosition(geometry)
    }

    default:
      return averagePosition(geometry)
  }
}

/** Area-weighted centroid of a ring. `undefined` when the ring is degenerate (zero area). */
function ringCentroid(ring: readonly Position[] | undefined): LngLat | undefined {
  if (ring === undefined || ring.length < 3) return undefined

  let area2 = 0
  let cx = 0
  let cy = 0

  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]
    const b = ring[i + 1]
    if (a === undefined || b === undefined) continue
    const [ax = 0, ay = 0] = a
    const [bx = 0, by = 0] = b
    const cross = ax * by - bx * ay
    area2 += cross
    cx += (ax + bx) * cross
    cy += (ay + by) * cross
  }

  // A zero-area ring — a collapsed parcel, or a "polygon" that is really a line —
  // divides by zero and yields NaN, which hit-tests as "not selected" everywhere
  // and is impossible to debug from the outside. Say so instead.
  if (area2 === 0) return undefined
  return [cx / (3 * area2), cy / (3 * area2)]
}

function signedArea2(ring: readonly Position[]): number {
  let sum = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]
    const b = ring[i + 1]
    if (a === undefined || b === undefined) continue
    sum += (a[0] ?? 0) * (b[1] ?? 0) - (b[0] ?? 0) * (a[1] ?? 0)
  }
  return sum
}

function averagePosition(geometry: Geometry): LngLat | undefined {
  let n = 0
  let lng = 0
  let lat = 0
  eachPosition(geometry, (position) => {
    n++
    lng += position[0] ?? 0
    lat += position[1] ?? 0
  })
  return n === 0 ? undefined : [lng / n, lat / n]
}

/** The bbox of a lasso ring, for the spatial-index pre-filter. */
export function ringBbox(ring: readonly LngLat[]): Bbox {
  return geometryBbox({ type: 'LineString', coordinates: ring.map((p) => [p[0], p[1]]) })
}

/**
 * The four corners of a drag box, converted from *screen* space.
 *
 * Built in pixels and unprojected rather than built from the two geographic
 * corners, because on a rotated map an axis-aligned rectangle in degrees is a
 * lozenge on screen — and the box the user drew is the one they expect to select.
 */
export function boxRing(a: ScreenPoint, b: ScreenPoint, unproject: Unproject): LngLat[] {
  const corners: ScreenPoint[] = [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ]
  const ring = corners.map(unproject)
  const first = ring[0]
  if (first === undefined) return []
  return [...ring, first]
}

export type Unproject = (point: ScreenPoint) => LngLat

/** Closes a freehand trace into a ring. `undefined` if it has no area to speak of. */
export function closeRing(points: readonly LngLat[]): LngLat[] | undefined {
  if (points.length < 3) return undefined
  const first = points[0]
  if (first === undefined) return undefined
  return [...points, first]
}
