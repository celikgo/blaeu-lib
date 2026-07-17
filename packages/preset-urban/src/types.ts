import type { CollectionId, CrsCode, Locale, Severity } from '@blaeu/core'
import type { AreaUnit, LengthUnit } from '@blaeu/plugin-measure'

/**
 * One entry in the plan legend.
 *
 * A zoning category is *data*, not code, and that is the whole reason the fill
 * colour of the zoning layer is a `match` expression rather than one layer per
 * category: a municipality that adds "Turizm Tesis Alanı" to the legend passes one
 * more object here and gets a styled, form-backed, area-reported category — without
 * touching this package.
 *
 * The three ratio/height caps are what a plan actually regulates, so they live on
 * the category rather than in a UI somewhere: the attribute form derives its `max`
 * from them, which is how "you cannot type a KAKS of 4 in a zone capped at 1.5"
 * becomes a property of the *plan*, not of a form widget.
 */
export interface ZoningCategory {
  /** Stable, short, and what is stored on the feature. `'K'`, `'T'`, `'S'` — the plan's own codes. */
  readonly code: string
  /** Human label, in the preset's locale. Also the i18n fallback for `urban.zoning.<code>`. */
  readonly label: string
  /** Fill colour, any CSS colour MapLibre accepts. */
  readonly color: string
  /** KAKS / emsal — floor area ratio. The cap for this category, if the plan sets one. */
  readonly maxFar?: number
  /** Gabari — building height cap, metres. */
  readonly maxHeight?: number
  /**
   * TAKS — ground coverage ratio, 0–1.
   *
   * Not in the minimal three-field category, but a plan that regulates KAKS and
   * gabari without TAKS does not exist: the same emsal spread over 30 % of the
   * parcel and over 60 % of it are two different neighbourhoods.
   */
  readonly maxCoverage?: number
}

/* ------------------------------------------------------------------ *
 * Attribute forms
 * ------------------------------------------------------------------ */

export type AttributeFieldType = 'number' | 'text' | 'select'

/** One row of the attribute form. Rendered by the host app; described here as data. */
export interface AttributeField {
  /** The key on `feature.properties`. */
  readonly name: string
  /** i18n key. `t()` falls back to the key itself, so a missing translation is ugly, never fatal. */
  readonly labelKey: string
  readonly type: AttributeFieldType
  /** Shown after the input: `m`, `m²`. Not localised — these are symbols, not words. */
  readonly unit?: string
  readonly min?: number
  /** Derived from the {@link ZoningCategory} caps, which is why the form cannot exceed the plan. */
  readonly max?: number
  readonly step?: number
  readonly required?: boolean
  /** Present for `type: 'select'`. */
  readonly options?: readonly AttributeOption[]
}

export interface AttributeOption {
  readonly value: string
  readonly labelKey: string
}

/** The form for one zoning category. */
export interface AttributeSchema {
  /** {@link ZoningCategory.code}. */
  readonly category: string
  readonly fields: readonly AttributeField[]
}

/** Every category's form, keyed by {@link ZoningCategory.code}. */
export type AttributeSchemas = Readonly<Record<string, AttributeSchema>>

/* ------------------------------------------------------------------ *
 * Preset options
 * ------------------------------------------------------------------ */

/**
 * Every number in this preset that a planning department would argue about.
 *
 * The test for whether something belongs here (preset rule 3): if a user would
 * have to copy `preset.ts` to change it, it should have been an option. A 5 m grid
 * is right for a district plan and wrong for a 1/1000 uygulama imar planı; a
 * municipality retunes it here rather than forking.
 */
export interface UrbanOptions {
  /**
   * Projected working CRS. Default `EPSG:5254` (TUREF / TM33 — central Türkiye).
   *
   * Areas and the 5 m grid are metres *on this plane*. Leaving it at the kernel's
   * `EPSG:3857` default would inflate every area report by ~70 % at Turkish
   * latitudes, and a scenario comparison whose numbers are 70 % wrong is worse
   * than one that refuses to run.
   */
  readonly crs?: CrsCode

  /** Default `'tr'`. */
  readonly locale?: Locale

  /** The plan legend. Defaults to {@link DEFAULT_ZONING_CATEGORIES}. */
  readonly zoningCategories?: readonly ZoningCategory[]

  /** Ship the scenario plugin. Default `true`. */
  readonly scenarios?: boolean

  /** Collection the zoning polygons live in. Default `'zoning'`. */
  readonly zoningCollection?: CollectionId

  /** Property carrying the {@link ZoningCategory.code}. Default `'zoning'`. */
  readonly zoningProperty?: string

  /**
   * Category stamped on a newly drawn polygon. Defaults to the first category.
   *
   * Must be a code present in {@link zoningCategories} — an unknown default would
   * draw polygons that the fill expression cannot colour and the area report cannot
   * attribute, so the preset throws instead.
   */
  readonly defaultCategory?: string

  /** Zoning fill opacity. Default `0.55` — solid enough to read, sheer enough to see the basemap. */
  readonly fillOpacity?: number

  /** Snap tolerance, screen pixels. Default `20`: a planner is sketching, not surveying. */
  readonly snapTolerance?: number

  /** Planning grid, metres in the working CRS. Default `5`. `0` disables grid snapping. */
  readonly gridSize?: number

  /** Undo depth. Default `500` — planners explore, and an explorer needs a long way back. */
  readonly undoDepth?: number

  /**
   * Severity of the *planning* topology rules — overlap, gap, sliver, undersized zone.
   *
   * Default `'warning'`. See the preset body for why this is the single most
   * important line in the file.
   */
  readonly topologySeverity?: Severity

  /**
   * Severity of the *structural* rules — unclosed ring, duplicate vertex,
   * self-intersection. Default `'error'`.
   *
   * Separate from {@link topologySeverity} because they are not the same kind of
   * judgement: an overlap is a planner's intent, a bowtie is broken data whose area
   * is undefined — and area is the number a scenario comparison reports.
   */
  readonly structuralSeverity?: Severity

  /** Smallest zone worth having, m². Default `100`. Reported at {@link topologySeverity}. */
  readonly minZoneArea?: number

  /** Default `'ha'` — the unit a plan is read in. `'m2'` for a 1/1000 application plan. */
  readonly areaUnit?: AreaUnit

  /** Default `'m'`. */
  readonly lengthUnit?: LengthUnit

  /**
   * Coordinate readout decimals. Default `2` (centimetres).
   *
   * Cadastre wants 3 (millimetres, because the number lands on a deed). A plan
   * boundary quoted to the millimetre claims a precision the plan does not have.
   */
  readonly precision?: number

  /**
   * Topological editing: a corner shared by two zones moves in both. Default `true`.
   *
   * Zoning polygons *tile* a block — they are not free-floating sketches. If a
   * shared edge drifts, the strip between the two zones belongs to no category, and
   * it will show up in a scenario area report as land that quietly evaporated.
   */
  readonly topologicalEditing?: boolean

  /**
   * Replace the derived attribute forms wholesale.
   *
   * The default forms are derived from {@link zoningCategories} — adding a category
   * gives you a form for free. Pass this only when a municipality's form genuinely
   * differs in *shape* (an extra "plan onay tarihi" field), not merely in its caps.
   */
  readonly attributeSchema?: AttributeSchemas
}
