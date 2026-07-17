import type { CollectionId, FeatureId, LineString, LngLat, Polygon } from '@blaeu/core'

/** The three things a surveyor asks a map: how far, how big, which way. */
export type MeasureMode = 'distance' | 'area' | 'bearing'

/**
 * `donum` is the Turkish **dönüm**: exactly 1 000 m².
 *
 * It is here because it is the unit a Turkish surveyor actually reads a parcel in
 * — a 2 000 m² parcel is "iki dönüm", not "two thousand square metres" — and a
 * measurement tool that cannot say it in the user's unit is a tool they will
 * mentally divide by 1 000 every single time.
 */
export type AreaUnit = 'm2' | 'ha' | 'km2' | 'donum'

export type LengthUnit = 'm' | 'km'

/** One leg of a measurement, with the two numbers a surveyor writes on the plan. */
export interface MeasureSegment {
  readonly from: LngLat
  readonly to: LngLat
  /** Planar length in the working CRS, metres. */
  readonly lengthMetres: number
  /** **Grid** bearing, degrees clockwise from grid north — not a geodesic azimuth. */
  readonly bearingDegrees: number
}

/**
 * A bearing, in both the forms a survey drawing carries.
 *
 * DMS is what goes on the plan and into a title deed; decimal degrees is what goes
 * into a spreadsheet. Showing one and making the user convert is how transcription
 * errors get into a legal document, so we show both.
 */
export interface BearingReadout {
  /** Grid bearing, decimal degrees, `[0, 360)`. */
  readonly degrees: number
  /** `123° 45' 12"` */
  readonly dms: string
  /** Localised decimal degrees: `123,7533°` in Turkish. */
  readonly decimal: string
}

/**
 * A completed (or in-progress) measurement.
 *
 * Everything in it is **planar, in the working CRS, in metres** — see
 * `MeasureOptions.planar` for why there is no other kind.
 */
export interface Measurement {
  /** Id of the geometry feature in the `measure` collection. Stable across undo/redo. */
  readonly id: FeatureId
  readonly mode: MeasureMode
  /** WGS84, like everything in the store. A closed `Polygon` only once an area has ≥ 3 vertices. */
  readonly geometry: LineString | Polygon
  readonly positions: readonly LngLat[]

  /**
   * The headline number, in the mode's own unit and **unconverted**: m² for area,
   * metres for distance, degrees for bearing. Raw, so a caller can do its own
   * arithmetic without unpicking a locale-formatted string.
   */
  readonly value: number

  /** {@link value}, converted to the configured unit and localised: `1.234,56 m²`. */
  readonly label: string

  /** Planar path length, or ring perimeter for a closed area. Metres. */
  readonly lengthMetres: number
  /** Planar area, m². `0` unless the geometry is a closed ring. */
  readonly areaMetres2: number

  readonly segments: readonly MeasureSegment[]

  /** Present for `mode: 'bearing'`. */
  readonly bearing?: BearingReadout

  /** True while the pointer still owns the last vertex — i.e. this is the rubber band. */
  readonly draft: boolean
}

export interface MeasureOptions {
  /** Default `'m2'`. The cadastre preset selects `'donum'`. */
  readonly areaUnit?: AreaUnit
  /** Default `'m'`. */
  readonly lengthUnit?: LengthUnit

  /**
   * Default `true`, and the only supported value.
   *
   * It exists as an option so that `planar: false` fails **loudly**, at setup, with
   * a message that explains itself — rather than silently doing sphere maths.
   * Spherical area on a 2 000 m² parcel at 39°N is wrong by square metres, which is
   * enough to move a boundary in a dispute. If your working CRS distorts your
   * extent, the fix is a better working CRS, not a rounder Earth.
   */
  readonly planar?: boolean

  /**
   * Keep completed measurements on the map. Default `true`.
   *
   * `false` gives the "one measurement at a time" behaviour of a ruler: starting a
   * new one clears the last.
   */
  readonly persist?: boolean
}

/** Every option present. What the plugin actually runs on. */
export interface ResolvedMeasureOptions {
  readonly areaUnit: AreaUnit
  readonly lengthUnit: LengthUnit
  readonly planar: boolean
  readonly persist: boolean
}

export interface MeasureApi {
  /** Activates the tool for `mode`. Equivalent to `map.tools.activate('measure:area')`. */
  start(mode: MeasureMode): void
  /** Removes every completed measurement, as one undoable step. Runs the commit pipeline. */
  clear(): Promise<void>
  /** Completed measurements, oldest first. Derived from the store, so undo shrinks it. */
  readonly measurements: readonly Measurement[]
  /**
   * Measures a feature that already exists — a parcel, an imported boundary —
   * **without** adding anything to the store.
   *
   * @throws if the feature is absent, or its geometry is not a `LineString` or a `Polygon`.
   */
  measureFeature(id: FeatureId): Measurement
}

/* ========================================================================= */
/* Names the plugin owns                                                     */
/* ========================================================================= */

/** Completed measurement geometry. */
export const MEASURE_COLLECTION: CollectionId = 'measure'
/** Completed labels: one Point per segment, plus the total. */
export const LABEL_COLLECTION: CollectionId = 'measure-labels'
/** The rubber band. Rewritten on every pointer move, and never recorded in history. */
export const DRAFT_COLLECTION: CollectionId = 'measure-draft'
export const DRAFT_LABEL_COLLECTION: CollectionId = 'measure-draft-labels'

/** The id every draft geometry feature carries, so a redraw replaces rather than accumulates. */
export const DRAFT_ID: FeatureId = 'measure-draft'

export const TOOL_IDS: Readonly<Record<MeasureMode, string>> = {
  distance: 'measure:distance',
  area: 'measure:area',
  bearing: 'measure:bearing',
}

/** Vertices needed before a mode can be completed. */
export const MIN_VERTICES: Readonly<Record<MeasureMode, number>> = {
  distance: 2,
  area: 3,
  bearing: 2,
}
