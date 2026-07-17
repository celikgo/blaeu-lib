import type {
  CrsService,
  FeatureId,
  BlaeuFeature,
  Geometry,
  I18n,
  LineString,
  LngLat,
  Polygon,
  Position,
} from '@blaeu/core'

import { formatArea, formatBearing, formatLength } from './format.js'
import type {
  BearingReadout,
  Measurement,
  MeasureSegment,
  MeasureMode,
  ResolvedMeasureOptions,
} from './types.js'

/**
 * The measurement maths. **Every number in this file comes out of `ctx.crs`.**
 *
 * That is not a stylistic preference. `@turf/area` is spherical, and on the 2 000 m²
 * parcel at 39°N that this repo's fixtures use, the spherical answer differs from
 * the projected one by square metres — enough to move a boundary in a land dispute.
 * The CRS service exists precisely so that no plugin has to know which formula is
 * the survey-grade one: it projects into the working plane (EPSG:5254 for a Turkish
 * cadastre), does honest planar maths in metres, and projects back. There is a test
 * named after this paragraph.
 */

/** Everything the maths needs, and nothing it does not. */
export interface MeasureEnv {
  readonly crs: CrsService
  readonly i18n: I18n
  readonly options: ResolvedMeasureOptions
}

/**
 * Turns a vertex list into a measurement.
 *
 * `positions` are the vertices as the user committed them — already snapped, already
 * quantised, because the interaction pipeline did that upstream (see `session.ts`).
 */
export function measurePositions(
  env: MeasureEnv,
  id: FeatureId,
  mode: MeasureMode,
  positions: readonly LngLat[],
  draft: boolean,
): Measurement {
  if (positions.length < 2) {
    throw new Error(
      `[measure] a ${mode} measurement needs at least 2 positions, got ${positions.length}. ` +
        `Callers should not build a measurement from a single click — wait for the pointer to give you the second point.`,
    )
  }

  const closed = mode === 'area' && positions.length >= 3
  const geometry: LineString | Polygon = closed
    ? { type: 'Polygon', coordinates: [toRing(positions)] }
    : { type: 'LineString', coordinates: positions.map(toPosition) }

  // The projection sandwich, once per number, all of it in the working plane.
  const lengthMetres = env.crs.length(geometry)
  const areaMetres2 = closed ? env.crs.area(geometry) : 0
  const segments = segmentsOf(env, positions, closed)

  const bearing: BearingReadout | undefined =
    mode === 'bearing' && segments[0] !== undefined
      ? formatBearing(segments[0].bearingDegrees, env.i18n)
      : undefined

  const value =
    mode === 'area' ? areaMetres2 : mode === 'distance' ? lengthMetres : (bearing?.degrees ?? 0)

  return {
    id,
    mode,
    geometry,
    positions: [...positions],
    value,
    label: labelFor(env, mode, { closed, lengthMetres, areaMetres2, bearing }),
    lengthMetres,
    areaMetres2,
    segments,
    // Spread rather than `bearing: undefined` — `exactOptionalPropertyTypes` draws a
    // real distinction between "absent" and "present and undefined", and so does
    // `toEqual`.
    ...(bearing !== undefined ? { bearing } : {}),
    draft,
  }
}

/**
 * Measures a feature already in the store. Adds nothing; mutates nothing.
 *
 * @param mode - forced mode. A stored measurement remembers what it *was*: a bearing
 *   is a two-point LineString, and re-reading it without its mode would silently
 *   demote it to a distance.
 */
export function measureFeature(
  env: MeasureEnv,
  feature: BlaeuFeature,
  mode?: MeasureMode,
): Measurement {
  const positions = geometryPositions(feature.geometry, feature.id)
  const inferred: MeasureMode = feature.geometry.type === 'Polygon' ? 'area' : 'distance'
  return measurePositions(env, feature.id, mode ?? inferred, positions, false)
}

/**
 * The vertices of a measurable geometry, with a Polygon's closing coordinate dropped
 * — `measurePositions` closes the ring itself, and a duplicated last vertex would
 * show up on the plan as a zero-length segment with a nonsense bearing.
 */
export function geometryPositions(geometry: Geometry, id: FeatureId): LngLat[] {
  if (geometry.type === 'LineString') return toLngLats(geometry.coordinates)

  if (geometry.type === 'Polygon') {
    const ring = geometry.coordinates[0]
    if (ring === undefined || ring.length < 4) {
      throw new Error(
        `[measure] feature "${id}" is a Polygon with no usable exterior ring. ` +
          `A ring needs at least 3 distinct vertices plus its closing coordinate.`,
      )
    }
    return toLngLats(ring.slice(0, -1))
  }

  throw new Error(
    `[measure] cannot measure feature "${id}": geometry type "${geometry.type}" has no single ` +
      `length or area to report. Supported: LineString (distance) and Polygon (area). ` +
      `For a Multi* geometry, call map.crs.area(feature.geometry) or map.crs.length(feature.geometry) directly — ` +
      `they aggregate over the parts, which is a number, but not a drawing.`,
  )
}

/**
 * The point a label sits on: the **planar** midpoint of the segment, in the working
 * CRS.
 *
 * Averaging lng/lat instead would put the label slightly off the drawn line — the
 * line is straight on the plan, and a geographic mean is not a point on it. At
 * parcel scale the error is millimetres and invisible; over a 40 km transect it is
 * metres, and the label detaches from its segment.
 */
export function segmentMidpoint(env: MeasureEnv, a: LngLat, b: LngLat): LngLat {
  const plane = env.crs.working
  const [ax, ay] = plane.forward(a)
  const [bx, by] = plane.forward(b)
  return plane.inverse([(ax + bx) / 2, (ay + by) / 2])
}

/**
 * The area-weighted centroid of a ring, computed on the plane.
 *
 * Falls back to the vertex mean for a degenerate (zero-area) ring, because the
 * centroid formula divides by the area and a user *will* click three collinear
 * points — and a NaN coordinate renders as "the label vanished", which is the
 * hardest kind of bug to report.
 */
export function ringCentroid(env: MeasureEnv, positions: readonly LngLat[]): LngLat {
  const plane = env.crs.working
  const xy = positions.map((p) => plane.forward(p))

  let twiceArea = 0
  let cx = 0
  let cy = 0

  for (let i = 0; i < xy.length; i++) {
    const a = xy[i]!
    const b = xy[(i + 1) % xy.length]!
    const cross = a[0] * b[1] - b[0] * a[1]
    twiceArea += cross
    cx += (a[0] + b[0]) * cross
    cy += (a[1] + b[1]) * cross
  }

  if (twiceArea === 0) {
    const sum = xy.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]] as const, [0, 0] as const)
    return plane.inverse([sum[0] / xy.length, sum[1] / xy.length])
  }

  return plane.inverse([cx / (3 * twiceArea), cy / (3 * twiceArea)])
}

/* ========================================================================= */
/* Internals                                                                 */
/* ========================================================================= */

function segmentsOf(
  env: MeasureEnv,
  positions: readonly LngLat[],
  closed: boolean,
): readonly MeasureSegment[] {
  const segments: MeasureSegment[] = []
  const last = closed ? positions.length : positions.length - 1

  for (let i = 0; i < last; i++) {
    const from = positions[i]!
    const to = positions[(i + 1) % positions.length]!
    segments.push({
      from,
      to,
      lengthMetres: env.crs.distance(from, to),
      // Grid bearing, clockwise from grid north on the projected plane. A surveyor
      // sets out from a grid bearing, not from a geodesic azimuth: the two differ by
      // the convergence of meridians, which at the edge of a 3° TM belt is minutes of
      // arc — and minutes of arc over 200 m is centimetres on the ground.
      bearingDegrees: env.crs.bearing(from, to),
    })
  }
  return segments
}

function labelFor(
  env: MeasureEnv,
  mode: MeasureMode,
  parts: {
    closed: boolean
    lengthMetres: number
    areaMetres2: number
    bearing: BearingReadout | undefined
  },
): string {
  const { areaUnit, lengthUnit } = env.options

  if (mode === 'bearing') {
    const bearing = parts.bearing
    return bearing === undefined ? '' : `${bearing.dms} (${bearing.decimal})`
  }

  // An area with only two vertices has no area yet, so it reports the length of what
  // the user has drawn so far. Showing "0,00 m²" while they are mid-polygon is
  // technically true and completely useless.
  if (mode === 'area' && !parts.closed) {
    return formatLength(parts.lengthMetres, lengthUnit, env.i18n)
  }

  return mode === 'area'
    ? formatArea(parts.areaMetres2, areaUnit, env.i18n)
    : formatLength(parts.lengthMetres, lengthUnit, env.i18n)
}

function toRing(positions: readonly LngLat[]): Position[] {
  const ring = positions.map(toPosition)
  // A fresh array for the closing coordinate, never a second reference to the first:
  // an in-place edit of vertex 0 would otherwise silently move the closing one too.
  const first = positions[0]!
  ring.push([first[0], first[1]])
  return ring
}

function toPosition(lngLat: LngLat): Position {
  return [lngLat[0], lngLat[1]]
}

function toLngLats(coordinates: readonly Position[]): LngLat[] {
  return coordinates.map((position, index) => {
    const lng = position[0]
    const lat = position[1]
    if (lng === undefined || lat === undefined) {
      throw new Error(
        `[measure] coordinate ${index} has fewer than two numbers: ${JSON.stringify(position)}. ` +
          `A geometry that got past the store's ingest should not be able to do this — please report it.`,
      )
    }
    return [lng, lat] as LngLat
  })
}
