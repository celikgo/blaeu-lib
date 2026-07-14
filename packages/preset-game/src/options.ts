import type { CollectionId, CrsCode } from '@fleximap/core'
import type { EntityType, GameOptions, ResolvedGameOptions, WorldBbox } from './types.js'

/** One tile. Thirty-two world units is a tile in roughly every 2D engine ever shipped. */
export const DEFAULT_GRID_SIZE = 32

/** 4096 × 4096 units — 128 × 128 tiles at the default grid. A comfortable first level. */
export const DEFAULT_BOUNDS: WorldBbox = [-2048, -2048, 2048, 2048]

/**
 * World units per degree.
 *
 * See the README for the derivation. The short version: this is the *only* number
 * that trades world extent against coordinate precision, and 100 000 puts a 4096-unit
 * world inside a 0.04° patch of the equator — small enough that a `double` degree
 * holds a world coordinate to ~1e-10 units, and large enough that a world of a
 * million units still fits comfortably inside a degree band.
 */
export const DEFAULT_UNITS_PER_DEGREE = 100_000

export const DEFAULT_CRS_CODE: CrsCode = 'GAME:WORLD'

/** A millitile. Fine enough for a decoration's jitter, coarse enough to keep the topology index honest. */
export const DEFAULT_PRECISION = 0.001

export const DEFAULT_COLLECTION: CollectionId = 'entities'
export const DEFAULT_ZONE_COLLECTION: CollectionId = 'zones'

/** Pixels. Generous, because a tile is a large target and a level designer places fast. */
export const DEFAULT_SNAP_TOLERANCE = 16

/**
 * Undo depth.
 *
 * Deliberately shallow. Cadastre keeps 200 because a surveyor's session is one
 * parcel and every step is legally significant; a level editor's session is ten
 * thousand placements and each undo step pins the features it removed, so a deep
 * stack is a memory leak with a nice name.
 */
export const DEFAULT_HISTORY_LIMIT = 50

export const DEFAULT_MAX_GRID_CELLS = 4096

/** A starter palette. Replaced wholesale by `entities:` — it exists so the preset runs out of the box. */
export const DEFAULT_ENTITIES: readonly EntityType[] = [
  { id: 'tree', label: 'Tree', icon: '🌲', size: 8 },
  { id: 'rock', label: 'Rock', icon: '🪨', size: 6 },
  { id: 'chest', label: 'Chest', icon: '🧰', size: 10 },
  { id: 'spawn', label: 'Spawn point', icon: '🚩', size: 12 },
]

export function resolveGameOptions(options: GameOptions = {}): ResolvedGameOptions {
  const gridSize = options.gridSize ?? DEFAULT_GRID_SIZE
  if (!Number.isFinite(gridSize) || gridSize <= 0) {
    throw new Error(
      `[preset-game] gridSize must be a positive number of world units, received ${String(options.gridSize)}. ` +
        `It is the tile size — 32 is the default. To place entities freely, set it to your precision (e.g. 0.001) ` +
        `rather than to zero.`,
    )
  }

  const bounds = options.bounds ?? DEFAULT_BOUNDS
  const [minX, minY, maxX, maxY] = bounds
  if (!(maxX > minX) || !(maxY > minY)) {
    throw new Error(
      `[preset-game] bounds must be [minX, minY, maxX, maxY] in world units with a positive extent, ` +
        `received [${bounds.join(', ')}]. Note this is *not* a lng/lat Bbox — the world has no geography.`,
    )
  }

  const unitsPerDegree = options.unitsPerDegree ?? DEFAULT_UNITS_PER_DEGREE
  if (!Number.isFinite(unitsPerDegree) || unitsPerDegree <= 0) {
    throw new Error(
      `[preset-game] unitsPerDegree must be a positive number, received ${String(options.unitsPerDegree)}. ` +
        `It is the scale of the world plane; the default (${DEFAULT_UNITS_PER_DEGREE}) suits worlds up to a few ` +
        `hundred thousand units across.`,
    )
  }

  const precision = options.precision ?? DEFAULT_PRECISION
  if (!Number.isFinite(precision) || precision <= 0) {
    throw new Error(
      `[preset-game] precision must be a positive quantisation grid in world units, received ${String(
        options.precision,
      )}. Every coordinate entering the store is snapped to it; 0.001 is the default.`,
    )
  }

  const entities = options.entities ?? DEFAULT_ENTITIES
  assertUniqueEntities(entities)

  const collection = options.collection ?? DEFAULT_COLLECTION

  return {
    gridSize,
    gridType: options.gridType ?? 'square',
    entities,
    bounds,
    locale: options.locale ?? 'en',
    collection,
    snapTolerance: options.snapTolerance ?? DEFAULT_SNAP_TOLERANCE,
    historyLimit: options.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    generators: options.generators ?? [],
    unitsPerDegree,
    crsCode: options.crsCode ?? DEFAULT_CRS_CODE,
    precision,
    backgroundColor: options.backgroundColor ?? '#0f1216',
    gridColor: options.gridColor ?? '#2b3440',
    gridOpacity: options.gridOpacity ?? 0.9,
    gridLineWidth: options.gridLineWidth ?? 1,
    majorEvery: options.majorEvery ?? 8,
    maxGridCells: options.maxGridCells ?? DEFAULT_MAX_GRID_CELLS,
    boundsSeverity: options.boundsSeverity ?? 'error',
    occupancySeverity: options.occupancySeverity ?? 'warning',
    ui: options.ui ?? true,
    attributions: options.attributions ?? [],
    zones: options.zones ?? true,
    zoneCollection: options.zoneCollection ?? DEFAULT_ZONE_COLLECTION,
    zoneColor: options.zoneColor ?? '#38bdf8',
  }
}

/**
 * A quantisation **grid** in world units → the **decimal places** `CrsConfig.precision`
 * is denominated in.
 *
 * The kernel keeps the two apart on purpose (it rejects `precision: 0.001` with a
 * message saying so), because a grid mistaken for a count of digits is a thousandfold
 * quantisation error that nothing downstream can detect. This preset's option is a
 * grid — a millitile is the natural unit for a level designer — so the conversion has
 * to happen somewhere, and it happens here, once, where it can be named.
 *
 * Clamped to the kernel's own 0–12 range: a grid finer than 1e-12 units is below the
 * resolution of the `double` that has to hold it anyway.
 */
export function crsDecimalPlaces(precision: number): number {
  return Math.min(12, Math.max(0, Math.round(-Math.log10(precision))))
}

/**
 * Two entity types under one id would make the icon match-expression pick one of
 * them arbitrarily and the entity picker show both — a bug that looks like a
 * rendering glitch for a day before anyone suspects the config.
 */
function assertUniqueEntities(entities: readonly EntityType[]): void {
  const seen = new Set<string>()
  for (const entity of entities) {
    if (seen.has(entity.id)) {
      throw new Error(
        `[preset-game] entity type "${entity.id}" is declared twice. Entity ids are the key the ` +
          `$entity property carries and the icon expression matches on, so they must be unique.`,
      )
    }
    seen.add(entity.id)
  }
}

/** Every collection the entity set writes to, in declaration order. Drives the layer list. */
export function entityCollections(options: ResolvedGameOptions): readonly CollectionId[] {
  const out: CollectionId[] = [options.collection]
  for (const entity of options.entities) {
    if (entity.layer !== undefined && !out.includes(entity.layer)) out.push(entity.layer)
  }
  return out
}
