/**
 * `@blaeu/preset-urban` — the kernel, as an urban planning tool.
 *
 * Everything importable from this package is here (core invariant 6). The preset
 * itself is a pure function returning plain data: no map, no DOM, no globals.
 */

export { urbanPlanningPreset } from './preset.js'
export {
  DEFAULT_URBAN_CRS,
  DEFAULT_SNAP_TOLERANCE_PX,
  DEFAULT_GRID_SIZE_M,
  DEFAULT_UNDO_DEPTH,
  DEFAULT_MIN_ZONE_AREA_M2,
  DEFAULT_ZONING_COLLECTION,
  DEFAULT_FILL_OPACITY,
  DEFAULT_PRECISION,
} from './preset.js'

export type {
  AttributeField,
  AttributeFieldType,
  AttributeOption,
  AttributeSchema,
  AttributeSchemas,
  UrbanOptions,
  ZoningCategory,
} from './types.js'

/* The legend, and the two pure functions derived from it. Exported because a host
 * app renders the legend and the attribute form, and both should be built from the
 * same data the map is styled from — not from a second copy that drifts. */
export {
  DEFAULT_ZONING_CATEGORIES,
  UNZONED_COLOR,
  FIELD,
  ZONING_FILL_LAYER,
  ZONING_OUTLINE_LAYER,
  zoningAttributeSchema,
  zoningFillColour,
  zoningLayers,
} from './zoning.js'
export type { ZoningLayerOptions } from './zoning.js'

/* The preset ships its own plugin. It is exported so it can be installed on its own
 * — a product that wants scenarios but not this preset's judgement is a legitimate
 * thing to want. */
export { scenarioPlugin, UNZONED } from './scenario.js'
export type {
  CategoryArea,
  CategoryDelta,
  Scenario,
  ScenarioApi,
  ScenarioComparison,
  ScenarioOptions,
} from './scenario.js'

export { urbanTheme } from './theme.js'
export { en, tr, urbanMessages } from './messages.js'
