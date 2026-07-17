import { definePreset, type CollectionId, type PluginSpec, type Preset } from '@blaeu/core'
import { drawPlugin } from '@blaeu/plugin-draw'
import { editPlugin } from '@blaeu/plugin-edit'
import { historyPlugin } from '@blaeu/plugin-history'
import { measurePlugin } from '@blaeu/plugin-measure'
import { selectPlugin } from '@blaeu/plugin-select'
import { snapPlugin } from '@blaeu/plugin-snap'
import {
  closedRings,
  minParcelArea,
  noDuplicateVertices,
  noGapsWithNeighbours,
  noOverlapWithNeighbours,
  noSelfIntersection,
  noSlivers,
  topologyPlugin,
} from '@blaeu/plugin-topology'

import { en, tr } from './messages.js'
import { scenarioPlugin } from './scenario.js'
import { urbanTheme } from './theme.js'
import type { AttributeSchemas, UrbanOptions, ZoningCategory } from './types.js'
import { DEFAULT_ZONING_CATEGORIES, FIELD, zoningAttributeSchema, zoningLayers } from './zoning.js'

/* ------------------------------------------------------------------ *
 * Defaults — exported, because a municipality overriding one wants to
 * know what it is overriding.
 * ------------------------------------------------------------------ */

/** TUREF / TM33: the 3° belt covering Ankara. Areas and the grid are metres on this plane. */
export const DEFAULT_URBAN_CRS = 'EPSG:5254'

/** Screen pixels. Twice cadastre's, and the number this preset is *about*. */
export const DEFAULT_SNAP_TOLERANCE_PX = 20

/** Metres, in the working CRS. The planning grid. */
export const DEFAULT_GRID_SIZE_M = 5

/** Undo steps. Cadastre keeps 200; a planner explores further and backs out more often. */
export const DEFAULT_UNDO_DEPTH = 500

/** m². Below this a zoning polygon is a digitising slip, not a plan decision. */
export const DEFAULT_MIN_ZONE_AREA_M2 = 100

export const DEFAULT_ZONING_COLLECTION: CollectionId = 'zoning'
export const DEFAULT_FILL_OPACITY = 0.55

/** Centimetres. A plan boundary quoted to the millimetre claims a precision it does not have. */
export const DEFAULT_PRECISION = 2

/**
 * The urban planning preset.
 *
 * Same kernel as cadastre. Same plugins as cadastre, near enough. Almost every
 * *number* different, and one severity inverted — which is the entire argument for
 * why judgement lives in a preset and not in a plugin.
 *
 * ```ts
 * const map = await createBlaeuMap({
 *   container: '#map',
 *   preset: urbanPlanningPreset({ crs: 'EPSG:5255', locale: 'tr' }),
 * })
 *
 * const scenarios = map.plugin('scenario')
 * scenarios.create('Mevcut')
 * // …redraw a few blocks…
 * scenarios.create('Yoğun')
 * console.table(scenarios.compare('Mevcut', 'Yoğun').categories)
 * ```
 *
 * Pure: it touches no map, no DOM, no global, and returns a plain object (preset
 * rule 1). You can `JSON.stringify` most of it, snapshot-test all of it, and
 * `composePresets` over any of it — see the README for how a municipality retunes it
 * without forking.
 */
export function urbanPlanningPreset(options: UrbanOptions = {}): Preset {
  const categories = options.zoningCategories ?? DEFAULT_ZONING_CATEGORIES
  assertLegend(categories)

  const collection = options.zoningCollection ?? DEFAULT_ZONING_COLLECTION
  const property = options.zoningProperty ?? FIELD.zoning
  const defaultCategory = resolveDefaultCategory(categories, options.defaultCategory)

  const crs = options.crs ?? DEFAULT_URBAN_CRS
  const precision = options.precision ?? DEFAULT_PRECISION
  const snapTolerance = positive(
    'snapTolerance',
    options.snapTolerance ?? DEFAULT_SNAP_TOLERANCE_PX,
  )
  const gridSize = options.gridSize ?? DEFAULT_GRID_SIZE_M
  const undoDepth = positive('undoDepth', options.undoDepth ?? DEFAULT_UNDO_DEPTH)
  const minZoneArea = options.minZoneArea ?? DEFAULT_MIN_ZONE_AREA_M2
  const fillOpacity = unitInterval('fillOpacity', options.fillOpacity ?? DEFAULT_FILL_OPACITY)

  const topologySeverity = options.topologySeverity ?? 'warning'
  const structuralSeverity = options.structuralSeverity ?? 'error'

  // One tolerance, derived from the readout precision, so the two cannot disagree.
  // A topology check that resolves 1 mm under a UI that only ever shows centimetres
  // reports "overlaps" the planner cannot see, cannot reproduce, and will learn to
  // dismiss — at which point the real overlaps get dismissed too.
  const tolerance = 10 ** -precision

  const schema: AttributeSchemas =
    options.attributeSchema ?? zoningAttributeSchema(categories, property)

  const plugins: PluginSpec[] = [
    [
      snapPlugin,
      {
        // 20 px, against cadastre's 12. A planner is sketching a proposal, not
        // reproducing a boundary that already legally exists: a snap that has to be
        // aimed at is a snap that gets turned off.
        tolerance: snapTolerance,
        // Grid snapping ON, which cadastre would never accept — there, the corner is
        // wherever the survey says it is, and rounding it to a grid *is* the error.
        // Here the grid is the point: a plan drawn on a 5 m module produces blocks that
        // subdivide into buildable plots, and one drawn freehand does not.
        ...(gridSize > 0 ? { gridSize } : {}),
        providers:
          gridSize > 0
            ? (['vertex', 'edge', 'midpoint', 'intersection', 'grid'] as const)
            : (['vertex', 'edge', 'midpoint', 'intersection'] as const),
      },
    ],
    [selectPlugin, { collections: [collection] }],
    [
      drawPlugin,
      {
        collection,
        defaultMode: 'polygon' as const,
        // Every new polygon lands already carrying a zoning code, which is what makes
        // the match-expression fill colour it the moment it is committed. A polygon
        // that has to be drawn *and then* classified renders grey in between, and the
        // grey flash reads as a bug.
        properties: () => ({ [property]: defaultCategory }),
      },
    ],
    [editPlugin, { topological: options.topologicalEditing ?? true }],
    [
      measurePlugin,
      { areaUnit: options.areaUnit ?? 'ha', lengthUnit: options.lengthUnit ?? 'm', planar: true },
    ],
    // autoFix stays off for the same reason as cadastre, for a different beneficiary:
    // buffer(0) on a self-intersecting zone changes its area, and the area is what the
    // scenario comparison reports back to a council.
    [topologyPlugin, { autoFix: false, tolerance }],
    [historyPlugin, { limit: undoDepth }],
  ]

  if (options.scenarios ?? true) {
    plugins.push([scenarioPlugin, { collection, property, categories }])
  }

  return definePreset({
    id: 'urban',
    description: 'Urban planning: zoning legend, 5 m planning grid, scenario comparison.',

    config: {
      crs: { working: crs, display: 'projected', precision },
      // Double-click closes a polygon here, as it does in every plan-drawing tool a
      // planner has ever used. It cannot also zoom.
      interaction: { doubleClickZoom: false },
    },

    plugins,

    validation: [
      /* ---- structural: broken data, not a plan decision ---- */
      // These are errors *by default* even though everything else here is a warning,
      // and the line is not arbitrary: an unclosed ring, a duplicate vertex or a bowtie
      // has no well-defined area — and the area is the number the scenario comparison
      // hands to a council. A warning-level bowtie means a report that is confidently
      // wrong, which is strictly worse than a report that refuses to run.
      closedRings({ severity: structuralSeverity }),
      noDuplicateVertices({ severity: structuralSeverity, tolerance }),
      noSelfIntersection({ severity: structuralSeverity }),

      /* ---- planning: judgement, and the whole point of this file ---- */
      //
      // WARNINGS, not errors. This is the *same topology plugin* the cadastre preset
      // installs, with the *opposite severity*, and that single inverted line is the
      // clearest demonstration in this repo that judgement belongs in the preset and
      // not in the plugin.
      //
      // In cadastre an overlap is a dispute: two people believe they own the same
      // ground, the geometry must never be stored, and an `error` that blocks the
      // commit is exactly right. In planning an overlap is a *thought*: a planner
      // dragging a commercial zone across a residential one to see what it would look
      // like is doing their job, and a tool that refuses the intermediate state is a
      // tool that gets closed. The plugin cannot know which of those it is looking at.
      // The preset can. So the plugin only ever *finds* the overlap, and the severity —
      // block, or mention — is set here, in one line, per domain.
      noOverlapWithNeighbours({ severity: topologySeverity, tolerance }),
      // A gap between two zones in a plan is usually a road, so this only fires on the
      // small ones (the plugin's default `maxGapArea`), where it is a slipped vertex.
      noGapsWithNeighbours({ severity: topologySeverity, tolerance }),
      noSlivers({ severity: topologySeverity }),
      minParcelArea({ severity: topologySeverity, minArea: minZoneArea }),
    ],

    layers: zoningLayers({ categories, collection, property, fillOpacity, schema }),

    theme: urbanTheme,
    i18n: { tr, en },
    locale: options.locale ?? 'tr',
  })
}

/* ------------------------------------------------------------------ *
 * Option checks. A preset is data, so a bad option is a bad *value* —
 * and a bad value found at construction is worth ten found at render.
 * ------------------------------------------------------------------ */

function assertLegend(categories: readonly ZoningCategory[]): void {
  if (categories.length === 0) {
    throw new Error(
      '[blaeu] urbanPlanningPreset: zoningCategories is empty. ' +
        'The legend drives the fill colours, the attribute forms and the scenario report, so an empty one ' +
        'yields a map with no styling and a comparison with no rows. Omit the option to use DEFAULT_ZONING_CATEGORIES.',
    )
  }

  const seen = new Set<string>()
  for (const category of categories) {
    if (seen.has(category.code)) {
      throw new Error(
        `[blaeu] urbanPlanningPreset: zoning code "${category.code}" appears twice. ` +
          `Codes are the key in the fill expression and in the area report, so a duplicate makes one of ` +
          `the two categories invisible and silently merges their areas.`,
      )
    }
    seen.add(category.code)
  }
}

function resolveDefaultCategory(
  categories: readonly ZoningCategory[],
  requested: string | undefined,
): string {
  if (requested === undefined) {
    // `assertLegend` has already rejected an empty legend, so this cannot be undefined
    // — but `noUncheckedIndexedAccess` does not know that, and it is right to insist.
    const first = categories[0]
    if (first === undefined) throw new Error('[blaeu] urbanPlanningPreset: no zoning categories.')
    return first.code
  }

  if (!categories.some((category) => category.code === requested)) {
    throw new Error(
      `[blaeu] urbanPlanningPreset: defaultCategory "${requested}" is not in zoningCategories ` +
        `(${categories.map((c) => c.code).join(', ')}). Every polygon drawn would carry a code that the ` +
        `fill expression cannot colour and the scenario report cannot attribute. Use one of those codes, ` +
        `or add "${requested}" to zoningCategories.`,
    )
  }
  return requested
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `[blaeu] urbanPlanningPreset: ${name} must be a finite number greater than 0, received ${String(value)}.`,
    )
  }
  return value
}

function unitInterval(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `[blaeu] urbanPlanningPreset: ${name} must be between 0 and 1, received ${String(value)}. ` +
        `It is an opacity, not a percentage — 0.55, not 55.`,
    )
  }
  return value
}
