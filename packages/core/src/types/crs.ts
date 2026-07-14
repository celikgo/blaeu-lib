import type { Geometry } from 'geojson'
import type { LngLat, ProjectedXY } from './common.js'

/** An EPSG code (`'EPSG:5254'`) or a registered custom name. */
export type CrsCode = string

/**
 * A projected coordinate reference system: a plane, in metres.
 *
 * `forward` and `inverse` must be exact inverses to within the CRS's precision.
 * Everything survey-grade goes through here.
 */
export interface ProjectedCrs {
  readonly code: CrsCode
  readonly name: string
  /** proj4 definition string. */
  readonly proj4: string
  /** Linear unit. Every CRS we ship is metres; the field exists so a foot-based CRS can't sneak through unnoticed. */
  readonly unit: 'metre' | 'foot'
  /** Rough validity extent, in 4326. Used to warn when a parcel is projected outside its zone. */
  readonly bounds?: readonly [number, number, number, number]

  forward(lngLat: LngLat): ProjectedXY
  inverse(xy: ProjectedXY): LngLat

  /** Quantisation grid, in metres. 0.001 = 1 mm. See `gis-geometry-precision`. */
  readonly precision: number
}

/**
 * Coordinate systems, and the reason cadastral numbers come out right.
 *
 * The store is always WGS84 (core invariant 3) — one interior CRS, no ambiguity.
 * But *sphere maths is not survey maths*: a spherical area on a 2 000 m² parcel
 * at 39°N is off by square metres, which is enough to move a boundary in a
 * dispute. So every precise operation projects into the **working CRS**, does
 * planar geometry in metres, and projects back.
 *
 * ```ts
 * const plane = map.crs.working                 // EPSG:5254, TUREF / TM30
 * const xy    = ring.map(plane.forward)         // → metres
 * const out   = offsetPolygonPlanar(xy, 2.5)    // real maths, real metres
 * const back  = out.map(plane.inverse)          // → lng/lat, back to the store
 * ```
 *
 * The `working` CRS is also what coordinate *readouts* and *exports* use, because
 * a Turkish surveyor wants to see and type `Y=458123.456  X=4421987.123`, not a
 * pair of decimal degrees.
 */
export interface CrsService {
  /** The plane used for all precise geometry, readouts, and exports. */
  readonly working: ProjectedCrs

  setWorking(code: CrsCode): void

  /** Look up any registered CRS. */
  get(code: CrsCode): ProjectedCrs | undefined

  /** Register a custom CRS. Municipalities have local systems; this is how they add them. */
  register(crs: Omit<ProjectedCrs, 'forward' | 'inverse'>): ProjectedCrs

  list(): readonly CrsCode[]

  /* --- convenience wrappers around the projection sandwich --- */

  /** Planar area in m². The number a land registry will accept. */
  area(geometry: Geometry): number

  /** Planar length/perimeter in metres. */
  length(geometry: Geometry): number

  /** Planar distance in metres. */
  distance(a: LngLat, b: LngLat): number

  /** Bearing in degrees, clockwise from grid north (not true north — grid north; surveyors care). */
  bearing(a: LngLat, b: LngLat): number

  /** Snap a coordinate to the working CRS's precision grid. Called on ingest. */
  quantise(lngLat: LngLat): LngLat

  /** Format for display, e.g. `'Y=458123.456 X=4421987.123'`. */
  format(lngLat: LngLat, options?: { readonly style?: 'projected' | 'dms' | 'decimal' }): string

  /** Parse a surveyor-typed coordinate string in the working CRS back to 4326. */
  parse(text: string): LngLat | undefined
}
