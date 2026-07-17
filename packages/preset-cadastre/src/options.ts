import type { CollectionId, CrsCode, Locale, Severity, SnapKind } from '@blaeu/core'
import type { AreaUnit, LengthUnit } from '@blaeu/plugin-measure'
import {
  DEFAULT_MAX_GAP_AREA_M2,
  DEFAULT_MIN_AREA_M2,
  DEFAULT_SLIVER_RATIO,
  DEFAULT_TOLERANCE_METRES,
} from '@blaeu/plugin-topology'

import type { AttributeSchema } from './schema.js'
import { parcelSchema } from './schema.js'

/**
 * Every knob a Kadastro Müdürlüğü — or a municipality, or a private survey firm —
 * would reasonably want to turn.
 *
 * The rule this list is written against: if someone would have to copy this file
 * to change a number, that number belongs here. Everything below has a default
 * that is defensible for Turkish cadastral work; nothing below is a value we would
 * defend for *every* jurisdiction, which is exactly why it is an option.
 */
export interface CadastreOptions {
  /**
   * The projected plane all geometry, readouts and exports live in.
   *
   * TUREF/TM30 (EPSG:5254) is the 3° belt centred on 30°E — Ankara, Konya, Antalya.
   * The wrong belt is not a rounding error: a parcel measured 6° from its central
   * meridian is off by metres. Use 5253 (27°E), 5255 (33°E) etc. for other belts.
   */
  readonly crs?: CrsCode

  readonly locale?: Locale

  /**
   * Screen pixels. Deliberately tight (12) rather than generous.
   *
   * A loose tolerance *invents* geometry: the pointer lands 30 px from a corner,
   * snapping drags it onto the corner anyway, and the parcel the surveyor thought
   * they drew is not the one that was stored. Slivers and phantom shared edges are
   * both downstream of a tolerance someone raised to make drawing feel easier.
   */
  readonly snapTolerance?: number

  /**
   * Which snap providers to install.
   *
   * `perpendicular` is deliberately absent from the default set: perpendicularity
   * is an *inference* about intent, and at cadastral scale it silently rotates a
   * boundary a surveyor placed by coordinate. Add it if your workflow wants it.
   */
  readonly snapProviders?: readonly SnapKind[]

  /** Metres in the working CRS. Omit for no grid snapping — the usual cadastral case. */
  readonly gridSize?: number

  /**
   * m². The floor below which a polygon is reported as suspiciously small.
   *
   * There is no single right answer here — the legal minimum for ifraz is set per
   * plan and per municipality — so the default is only "smaller than this is
   * almost certainly a mis-click", not "smaller than this is illegal". Set it to
   * your jurisdiction's figure and the rule starts saying something true.
   */
  readonly minParcelArea?: number

  /** Where parcels and buildings live. Rename them to match an existing schema. */
  readonly collections?: {
    readonly parcels?: CollectionId
    readonly buildings?: CollectionId
  }

  /**
   * Promote the advisory rules — gap, sliver, undersized parcel — from `warning`
   * to `error`, so they block the write instead of annotating it.
   *
   * Off by default. A surveyor mid-digitisation legitimately has a temporary gap;
   * refusing to store the parcel until it closes means they cannot store the
   * neighbour they need in order to close it. Turn this on at the *submission*
   * boundary — a batch import, a server-side check — where a clean dataset is the
   * contract rather than the goal.
   */
  readonly strictTopology?: boolean

  /** Decimal places in the working CRS's metres. 3 = millimetres. */
  readonly precision?: number

  /** Metres. Below this, two coordinates are the same corner. Default 1 mm. */
  readonly tolerance?: number

  /** perimeter²/area above which a polygon is reported as a sliver. */
  readonly sliverRatio?: number

  /** m². A void larger than this between two parcels is a road, not a digitisation slip. */
  readonly maxGapArea?: number

  /** Dönüm (1 000 m²) is the unit a Turkish surveyor thinks in. */
  readonly areaUnit?: AreaUnit
  readonly lengthUnit?: LengthUnit

  /** Undo depth. 200 ≈ an afternoon's digitising. */
  readonly historyLimit?: number

  /** Vertex grab radius, in screen pixels. 10 is a fingertip on a tablet in the field. */
  readonly handleSize?: number

  /**
   * How loudly to complain about a parcel with no ada/parsel.
   *
   * `'warning'`, not `'error'`, and the asymmetry is the point: the geometry is
   * drawn *before* the deed is typed. An error here would make it impossible to
   * store the parcel you are about to attribute. Escalate it to `'error'` at the
   * submission boundary, or pass `'off'` for a workflow that attributes elsewhere.
   */
  readonly attributeSeverity?: Severity | 'off'

  /**
   * Recompute `yuzolcumu` from the geometry on every write. Default `true`.
   *
   * Area is *derived*, never typed. A hand-entered area that disagrees with the
   * boundary is the single most common source of a cadastral dispute, and the
   * cheapest way to never have one is to make the field un-typeable.
   */
  readonly deriveArea?: boolean

  /** Decimal places on the derived area. 2 = cm², which is already past what a deed prints. */
  readonly areaDecimals?: number

  /** Replace or extend the parcel form's fields — a municipality with extra columns. */
  readonly parcelSchema?: AttributeSchema

  /** A MapLibre style URL or style JSON. See `paleRasterBasemap()` for the usual shape. */
  readonly basemap?: string | Record<string, unknown>

  /** Shown by the attribution control. Your orthophoto's licence goes here. */
  readonly attributions?: readonly string[]
}

/** {@link CadastreOptions} with every default filled in. What the preset body reads. */
export interface ResolvedCadastreOptions {
  readonly crs: CrsCode
  readonly locale: Locale
  readonly snapTolerance: number
  readonly snapProviders: readonly SnapKind[]
  readonly gridSize: number | undefined
  readonly minParcelArea: number
  readonly parcels: CollectionId
  readonly buildings: CollectionId
  readonly strictTopology: boolean
  readonly precision: number
  readonly tolerance: number
  readonly sliverRatio: number
  readonly maxGapArea: number
  readonly areaUnit: AreaUnit
  readonly lengthUnit: LengthUnit
  readonly historyLimit: number
  readonly handleSize: number
  readonly attributeSeverity: Severity | 'off'
  readonly deriveArea: boolean
  readonly areaDecimals: number
  readonly parcelSchema: AttributeSchema
  readonly basemap: string | Record<string, unknown> | undefined
  readonly attributions: readonly string[]
}

/** TUREF / TM30 — the 3° belt centred on 30°E. */
export const DEFAULT_CADASTRE_CRS: CrsCode = 'EPSG:5254'
export const DEFAULT_SNAP_TOLERANCE_PX = 12
export const DEFAULT_HISTORY_LIMIT = 200
export const DEFAULT_HANDLE_SIZE_PX = 10
export const DEFAULT_AREA_DECIMALS = 2
/** Millimetres. What a Turkish cadastral coordinate list is printed to. */
export const DEFAULT_PRECISION = 3

export const PARCELS_COLLECTION: CollectionId = 'parcels'
export const BUILDINGS_COLLECTION: CollectionId = 'buildings'

export const DEFAULT_SNAP_PROVIDERS: readonly SnapKind[] = [
  'vertex',
  'edge',
  'midpoint',
  'intersection',
  'extension',
]

export function resolveCadastreOptions(options: CadastreOptions = {}): ResolvedCadastreOptions {
  const snapTolerance = options.snapTolerance ?? DEFAULT_SNAP_TOLERANCE_PX
  if (!Number.isFinite(snapTolerance) || snapTolerance < 0) {
    throw new Error(
      `[blaeu] cadastrePreset: snapTolerance must be a finite number of screen pixels >= 0, ` +
        `received ${String(options.snapTolerance)}. Pass 0 to draw with snapping installed but never engaging.`,
    )
  }

  const precision = options.precision ?? DEFAULT_PRECISION
  if (!Number.isInteger(precision) || precision < 0) {
    throw new Error(
      `[blaeu] cadastrePreset: precision must be a non-negative integer number of decimal ` +
        `places in the working CRS's metres, received ${String(options.precision)}. Use 3 for millimetres.`,
    )
  }

  return {
    crs: options.crs ?? DEFAULT_CADASTRE_CRS,
    locale: options.locale ?? 'tr',
    snapTolerance,
    snapProviders: options.snapProviders ?? DEFAULT_SNAP_PROVIDERS,
    gridSize: options.gridSize,
    minParcelArea: options.minParcelArea ?? DEFAULT_MIN_AREA_M2,
    parcels: options.collections?.parcels ?? PARCELS_COLLECTION,
    buildings: options.collections?.buildings ?? BUILDINGS_COLLECTION,
    strictTopology: options.strictTopology ?? false,
    precision,
    tolerance: options.tolerance ?? DEFAULT_TOLERANCE_METRES,
    sliverRatio: options.sliverRatio ?? DEFAULT_SLIVER_RATIO,
    maxGapArea: options.maxGapArea ?? DEFAULT_MAX_GAP_AREA_M2,
    areaUnit: options.areaUnit ?? 'donum',
    lengthUnit: options.lengthUnit ?? 'm',
    historyLimit: options.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    handleSize: options.handleSize ?? DEFAULT_HANDLE_SIZE_PX,
    attributeSeverity: options.attributeSeverity ?? 'warning',
    deriveArea: options.deriveArea ?? true,
    areaDecimals: options.areaDecimals ?? DEFAULT_AREA_DECIMALS,
    parcelSchema: options.parcelSchema ?? parcelSchema,
    basemap: options.basemap,
    attributions: options.attributions ?? [],
  }
}
