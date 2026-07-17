/**
 * The public API of `@blaeu/core` (core invariant 6).
 *
 * If it is not re-exported here, it is not public, and a plugin that reaches past
 * this barrel into a deep path is depending on an internal that will move. The
 * testing harness is deliberately absent — it lives behind `@blaeu/core/testing`
 * so that a production bundle never pulls in the fake renderer or the fixtures.
 */

/* ---- the kernel ---- */
export { BlaeuMap, createBlaeuMap } from './BlaeuMap.js'

/* ---- every interface and type in the contract ---- */
export * from './types/index.js'

/* ---- the concrete kernel classes ----
 *
 * Exported as values, not just types, because a host app that wants a bare event
 * bus in a worker, or a preset that wants to construct a command bus in a test,
 * has no other honest way to get one. */
export { BlaeuEventBus } from './events/EventBus.js'
export { SyncInteractionPipeline, AsyncCommitPipeline } from './pipeline/Pipeline.js'
export { BlaeuCommandBus, CompositeCommand } from './commands/CommandBus.js'
export { BlaeuPluginManager } from './plugins/PluginManager.js'
export type { ContextFactory } from './plugins/PluginManager.js'
export { BlaeuFeatureStore, BlaeuCollection } from './store/FeatureStore.js'
export { BlaeuTopologyIndex } from './store/TopologyIndex.js'
export { SpatialIndex } from './store/SpatialIndex.js'
export { BlaeuToolManager } from './tools/ToolManager.js'
export { BlaeuLayerManager } from './layers/LayerManager.js'
export { BlaeuCrsService } from './crs/CrsService.js'
export { BlaeuThemeManager } from './theme/ThemeManager.js'
export { BlaeuI18n } from './i18n/I18n.js'
export { BlaeuValidationRegistry } from './validation/ValidationRegistry.js'

/* ---- renderers ---- */
export {
  MapLibreRenderer,
  blankStyle,
  ID_PROPERTY,
  LOCKED_PROPERTY,
  HIDDEN_PROPERTY,
} from './renderers/MapLibreRenderer.js'
export type { MapLibreRendererOptions } from './renderers/MapLibreRenderer.js'

/* ---- built-in commands. The vocabulary every plugin mutates the store with. ---- */
export {
  AddFeaturesCommand,
  UpdateFeaturesCommand,
  RemoveFeaturesCommand,
  SetPropertiesCommand,
} from './commands/builtins.js'
export type { CommandOptions } from './commands/builtins.js'

/* ---- built-in layer types ---- */
export { createVectorLayerType } from './layers/vectorLayerType.js'
export { createRasterLayerType } from './layers/rasterLayerType.js'
export type { RasterLayerConfig } from './layers/rasterLayerType.js'

/* ---- presets ---- */
export {
  definePreset,
  composePresets,
  overridePreset,
  normalisePluginSpec,
} from './presets/compose.js'

/* ---- config ---- */
export {
  resolveConfig,
  DEFAULT_CRS,
  DEFAULT_INTERACTION,
  DEFAULT_CAMERA,
  DEFAULT_LOCALE,
} from './config.js'

/* ---- theme / i18n defaults, so a preset can extend rather than restate them ---- */
export { defaultTheme } from './theme/defaultTheme.js'
/* ---- built-in themes + the builder that keeps a theme's ground and its tokens in sync ---- */
export {
  builtinThemes,
  DEFAULT_SCHEME_THEMES,
  twitterLight,
  twitterDim,
  twitterBlack,
  surveyPaper,
  highContrast,
  imageryDark,
  buildTheme,
  flatBasemap,
} from './theme/themes/index.js'
export type { ThemeDraft } from './theme/themes/index.js'
export { en } from './i18n/messages/en.js'
export { tr } from './i18n/messages/tr.js'

/* ---- CRS ---- */
export { BUILTIN_CRS, GEOGRAPHIC_CODES, WGS84_PROJ4, DEFAULT_PRECISION } from './crs/registry.js'
export type { CrsSpec } from './crs/registry.js'
export {
  signedRingArea,
  ringArea,
  polygonArea,
  pathLength,
  ringPerimeter,
  polygonPerimeter,
  distanceXY,
  gridBearing,
  snapToGrid,
  snapXYToGrid,
  decimalsForGrid,
} from './crs/planar.js'

/* ---- utils plugins legitimately need ---- */
export { createId } from './utils/ids.js'
export { satisfies } from './utils/semver.js'
export { createConsoleLogger, silentLogger } from './utils/logger.js'
export type { LogSink, ConsoleLoggerOptions } from './utils/logger.js'
export {
  toLngLat,
  positionsEqual,
  quantisePosition,
  dedupeConsecutive,
  isRingClosed,
  ringSignedArea2,
  normaliseRing,
  normaliseGeometry,
  eachVertex,
  eachPosition,
  geometryBbox,
  planarDistance,
  distanceToSegment,
  pointInRing,
  distanceToGeometryMetres,
  bboxAround,
} from './utils/geometry.js'
export type { Quantiser } from './utils/geometry.js'
