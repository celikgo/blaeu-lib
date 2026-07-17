import { toLngLat } from '@blaeu/core'
import type { CrsService, LngLat, ProjectedXY } from '@blaeu/core'

/**
 * Douglas-Peucker, in the projected plane, with a tolerance in metres.
 *
 * Iterative rather than recursive: a freehand trace on a touch device is routinely five
 * thousand points, and the worst case for the recursive form is a stack frame per point.
 * A blown stack in the middle of a gesture is a spectacularly unhelpful failure.
 */
export function douglasPeucker(points: readonly ProjectedXY[], tolerance: number): ProjectedXY[] {
  if (points.length <= 2 || tolerance <= 0) return [...points]

  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true

  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    if (last - first < 2) continue

    const a = points[first]!
    const b = points[last]!

    let worst = -1
    let worstDistance = 0
    for (let i = first + 1; i < last; i++) {
      const distance = perpendicularDistance(points[i]!, a, b)
      if (distance > worstDistance) {
        worstDistance = distance
        worst = i
      }
    }

    if (worst > 0 && worstDistance > tolerance) {
      keep[worst] = true
      stack.push([first, worst], [worst, last])
    }
  }

  const out: ProjectedXY[] = []
  for (let i = 0; i < points.length; i++) {
    if (keep[i] === true) out.push(points[i]!)
  }
  return out
}

/**
 * Simplifies a geographic trace by projecting it, running Douglas-Peucker in metres, and
 * projecting back — the projection sandwich, because a tolerance in degrees means a
 * different thing at every latitude.
 *
 * This is not an optimisation, it is a correctness measure. A raw trace carries one vertex
 * per pointer sample: thousands of near-collinear points, many of them closer together than
 * the CRS's precision grid. Feed that to a topology check or a boolean op and you get
 * spikes, slivers and a machine that appears to have hung.
 */
export function simplifyTrace(
  crs: CrsService,
  points: readonly LngLat[],
  toleranceMetres: number,
): LngLat[] {
  if (points.length <= 2) return [...points]
  const plane = crs.working
  const projected = points.map((p) => plane.forward(p))
  return douglasPeucker(projected, toleranceMetres).map((xy) => toLngLat([...plane.inverse(xy)]))
}

/** Distance from `p` to the segment `a`→`b`. Degenerate segments fall back to point distance. */
function perpendicularDistance(p: ProjectedXY, a: ProjectedXY, b: ProjectedXY): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSquared = dx * dx + dy * dy

  if (lengthSquared === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])

  // Clamped, so a point beyond an endpoint measures to the endpoint rather than to the
  // infinite line — otherwise a trace that doubles back on itself keeps the wrong vertex.
  const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}
