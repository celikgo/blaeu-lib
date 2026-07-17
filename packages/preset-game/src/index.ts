/**
 * `@blaeu/preset-game` — the same kernel, aimed at a level editor.
 *
 * ```ts
 * const map = await createBlaeuMap({
 *   container: '#map',
 *   preset: gameMapPreset({ gridSize: 32, gridType: 'square' }),
 * })
 * ```
 *
 * This package exists to falsify the obvious objection to BlaeuMap — that a
 * "geospatial kernel" is really just a GIS library with a plugin API bolted on.
 * A game world has no geodesy, no basemap, and no cadastral topology. If the core
 * had assumed any of those, this preset would be impossible without forking it.
 *
 * It isn't, because of three seams the core deliberately left open:
 *
 * - `crs.register()` — the world is a plane in arbitrary units, registered as a
 *   custom CRS. Every planar facility in the kernel (snapping, grid quantisation,
 *   distance, area) then works on it unchanged, because none of them were written
 *   against the Earth; they were written against `crs.working`.
 * - `layers.registerType()` — `tile-grid` is a rendering category the core has
 *   never heard of, added here in one file.
 * - the commit pipeline — procedural generation runs as commit middleware, which
 *   is the same seam the cadastre preset uses for topology validation. The kernel
 *   does not know that one spawns decorations and the other prevents a lawsuit.
 *
 * And one thing it *doesn't* install: `@blaeu/plugin-topology`. A level has no
 * parcels, so the preset omits it — and the bundle does not carry JSTS. That is
 * only possible because topology was a plugin rather than a core feature.
 */

export { gameMapPreset } from './preset.js'

/* ---- options ---- */
export type { GameOptions, ResolvedGameOptions } from './types.js'
export {
  resolveGameOptions,
  entityCollections,
  DEFAULT_GRID_SIZE,
  DEFAULT_BOUNDS,
  DEFAULT_UNITS_PER_DEGREE,
  DEFAULT_CRS_CODE,
  DEFAULT_PRECISION,
  DEFAULT_COLLECTION,
  DEFAULT_ZONE_COLLECTION,
  DEFAULT_SNAP_TOLERANCE,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_MAX_GRID_CELLS,
  DEFAULT_ENTITIES,
} from './options.js'

/* ---- the world plane ---- */
export type { WorldApi, WorldBbox, WorldXY, WorldTransform, GridType } from './types.js'
export { worldCrsPlugin } from './plugins/worldCrs.js'
export {
  worldCrsSpec,
  createWorldTransform,
  worldRadius,
  assertWorldFits,
  snapToSquare,
  worldContains,
} from './world.js'

/* ---- entities ---- */
export type { EntityType, EntityApi, EntityGenerator, GenerateContext } from './types.js'
export { entityPlugin, PLACE_TOOL } from './plugins/entity.js'
export { ENTITY_PROPERTY, GENERATED_PROPERTY, entityStyle, zoneStyle } from './styles.js'

/* ---- the custom layer type ---- */
export { tileGridPlugin, TILE_GRID_TYPE, HEX_SNAP_KIND } from './plugins/tileGrid.js'
export type { TileGridConfig } from './plugins/tileGrid.js'
export { gameLayers } from './layers.js'

/* ---- hex geometry, for a hex-grid world ---- */
export {
  hexCircumradius,
  hexRowSpacing,
  hexCentre,
  hexRing,
  nearestHexCentre,
  hexCentresIn,
} from './hex.js'

/* ---- procedural generation, as commit middleware ---- */
export { scatterAround } from './generators.js'
export type { ScatterOptions } from './generators.js'

/* ---- validation, theme, messages: exported so a product can compose over them ---- */
export { gameRules, RULE_IN_BOUNDS, RULE_TILE_OCCUPIED } from './validation.js'
export { gameTheme } from './theme.js'
export { en as gameMessagesEn, tr as gameMessagesTr } from './messages.js'
