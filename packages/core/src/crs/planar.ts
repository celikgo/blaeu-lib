import type { ProjectedXY } from '../types/common.js'

/**
 * Planar geometry, in a projected plane, in that plane's linear unit.
 *
 * Nothing in this file knows what a longitude is, and that is the point. Every
 * function here takes coordinates that have *already* been through
 * `ProjectedCrs.forward` — so it is structurally impossible to accidentally run a
 * shoelace sum over degrees and get an "area" of 0.0002 that renders perfectly
 * and means nothing.
 *
 * See `gis-geometry-precision`: this is the "raw planar maths for survey-grade
 * numbers" row of the table.
 */

/**
 * Signed area of a ring. Positive when the ring is counter-clockwise.
 *
 * The sum is taken relative to the ring's first vertex rather than the origin.
 * That matters more than it looks: a Turkish northing is ~4.4e6, so the naive
 * shoelace multiplies numbers of order 1e11 and then subtracts them to recover a
 * value of order 1e3. That cancellation throws away roughly six significant
 * digits — enough to move a small parcel's area by square centimetres, and enough
 * to make the result depend on where in the world the parcel is. Translating to a
 * local origin first keeps every product at the scale of the parcel itself.
 *
 * A ring may be given closed (last === first) or open; the wrap-around term makes
 * both correct, because a duplicated closing vertex contributes exactly zero.
 */
export function signedRingArea(ring: readonly ProjectedXY[]): number {
  const n = ring.length
  if (n < 3) return 0

  const origin = ring[0]!
  const ox = origin[0]
  const oy = origin[1]

  let sum = 0
  for (let i = 0; i < n; i++) {
    const a = ring[i]!
    const b = ring[(i + 1) % n]!
    sum += (a[0] - ox) * (b[1] - oy) - (b[0] - ox) * (a[1] - oy)
  }
  return sum / 2
}

/** Unsigned area of a single ring. */
export function ringArea(ring: readonly ProjectedXY[]): number {
  return Math.abs(signedRingArea(ring))
}

/**
 * Area of a polygon: outer ring minus holes.
 *
 * Holes are subtracted by their *absolute* area rather than by their signed area,
 * because ring winding in real data is not trustworthy. RFC 7946 says exterior
 * rings wind counter-clockwise and holes clockwise, and a large fraction of the
 * data a land registry receives ignores that. Relying on the sign would make a
 * wrongly-wound hole *add* its area instead of removing it, which turns a
 * courtyard into extra land. The ring's position in the array is the only signal
 * GeoJSON actually guarantees, so that is the signal we use.
 */
export function polygonArea(rings: readonly (readonly ProjectedXY[])[]): number {
  const outer = rings[0]
  if (!outer) return 0

  let area = ringArea(outer)
  for (let i = 1; i < rings.length; i++) {
    area -= ringArea(rings[i]!)
  }
  // A hole larger than its shell is nonsense geometry; clamping to zero at least
  // refuses to report a negative area, which no downstream consumer expects.
  return Math.max(area, 0)
}

/** Length of an open path. The closing segment is *not* implied. */
export function pathLength(coords: readonly ProjectedXY[]): number {
  let total = 0
  for (let i = 1; i < coords.length; i++) {
    total += distanceXY(coords[i - 1]!, coords[i]!)
  }
  return total
}

/**
 * Perimeter of a ring, closing it implicitly if it was given open.
 *
 * GeoJSON requires closed rings, but the wire is full of open ones, and silently
 * dropping the closing segment understates a perimeter by one edge — which is the
 * kind of error that is small enough to survive review and large enough to matter.
 */
export function ringPerimeter(ring: readonly ProjectedXY[]): number {
  if (ring.length < 2) return 0

  let total = pathLength(ring)
  const first = ring[0]!
  const last = ring[ring.length - 1]!
  if (first[0] !== last[0] || first[1] !== last[1]) total += distanceXY(last, first)
  return total
}

/** Perimeter of a polygon, holes included — a courtyard has a wall too. */
export function polygonPerimeter(rings: readonly (readonly ProjectedXY[])[]): number {
  let total = 0
  for (const ring of rings) total += ringPerimeter(ring)
  return total
}

/** Euclidean distance in the plane. */
export function distanceXY(a: ProjectedXY, b: ProjectedXY): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

/**
 * Grid bearing: degrees clockwise from **grid north**, in `[0, 360)`.
 *
 * Grid north is the +y axis of the projection, not true north and not magnetic
 * north. The difference from true north (the meridian convergence) reaches ~1° at
 * the edge of a 3-degree TM belt at Turkish latitudes, so the two are absolutely
 * not interchangeable. Surveyors read and stake grid bearings, because those are
 * what agree with the coordinates on the plan; a geodesic azimuth would not.
 */
export function gridBearing(from: ProjectedXY, to: ProjectedXY): number {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (dx === 0 && dy === 0) return 0

  // atan2(easting, northing) — arguments deliberately in that order: it measures
  // from the +y axis toward +x, i.e. clockwise from north, which is the surveying
  // convention and the transpose of the usual maths convention.
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI
  return (deg + 360) % 360
}

/**
 * The number of decimal places a grid corresponds to, or `undefined` if the grid
 * is not a negative power of ten (0.005 m, say — a legal choice, just not a
 * decimal one).
 */
export function decimalsForGrid(grid: number): number | undefined {
  if (!(grid > 0) || !Number.isFinite(grid)) return undefined

  const places = Math.round(-Math.log10(grid))
  if (places < 0 || places > 15) return undefined
  return Math.abs(10 ** -places - grid) < Number.EPSILON * grid ? places : undefined
}

/**
 * Snap a value to a grid, in the plane's unit.
 *
 * The decimal branch is not an optimisation. `Math.round(v / 0.001) * 0.001`
 * reintroduces float error — 458123.456 comes back as 458123.45600000004 — so a
 * coordinate quantised to the millimetre would *not* survive a
 * `parse(format(x))` round-trip, and two coordinates that a surveyor typed
 * identically would compare unequal. Rounding through the decimal representation
 * yields the nearest double to the decimal the user actually means, which is the
 * same double `Number('458123.456')` yields. Making those two paths agree
 * bit-for-bit is what keeps the precision grid a *grid*.
 */
export function snapToGrid(value: number, grid: number): number {
  const places = decimalsForGrid(grid)
  if (places === undefined) return Math.round(value / grid) * grid
  return Number(value.toFixed(places))
}

/** Snap a projected coordinate to the precision grid. */
export function snapXYToGrid(xy: ProjectedXY, grid: number): ProjectedXY {
  return [snapToGrid(xy[0], grid), snapToGrid(xy[1], grid)]
}
