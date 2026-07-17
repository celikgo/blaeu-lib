import type {
  Disposable,
  BlaeuFeature,
  BlaeuPlugin,
  LayerInstance,
  LayerSpec,
  LayerStyle,
  LayerTypeDef,
  LngLat,
  PluginContext,
  SnapCandidate,
  SnapProvider,
  SnapQueryContext,
} from '@blaeu/core'
import { resolveGameOptions } from '../options.js'
import type { GameOptions, GridType, ResolvedGameOptions, WorldApi, WorldBbox } from '../types.js'
import { hexCentresIn, hexRing, nearestHexCentre } from '../hex.js'
import { createWorldTransform } from '../world.js'

/** The layer type this plugin registers. `map.layers.add({ type: TILE_GRID_TYPE })`. */
export const TILE_GRID_TYPE = 'tile-grid'

/** The snap kind the hex provider produces. Not a built-in — the kernel has never heard of a hex. */
export const HEX_SNAP_KIND = 'hex-centre'

/**
 * Per-layer configuration. Everything defaults to the plugin's own options, so
 * `{ id: 'grid', type: 'tile-grid' }` is a complete layer spec — and a second grid
 * layer at a different spacing (a coarse "chunk" overlay, say) is one object.
 */
export interface TileGridConfig {
  readonly gridSize?: number
  readonly gridType?: GridType
  readonly bounds?: WorldBbox
  readonly color?: string
  readonly opacity?: number
  readonly lineWidth?: number
  readonly majorEvery?: number
  readonly maxGridCells?: number
}

/** Set on the heavier every-Nth line, so one layer can draw both weights. */
const MAJOR_PROPERTY = '$major'

/**
 * The grid itself, as a **layer type**.
 *
 * This is the point of `LayerTypeDef`: `vector` and `raster` are the only categories
 * the kernel ships, and neither can draw a tilemap grid. Rather than teaching the
 * core about grids (which would mean teaching it about games), the game plugin
 * registers a third category. From then on `map.layers.add({ type: 'tile-grid' })`
 * works exactly like `'vector'` does — same manager, same z-ordering, same
 * `setVisible`, same `beforeId` — and the core still has never heard of a tile.
 *
 * The grid features are built here and pushed **straight to the renderer**, never
 * into the store. That is deliberate, and it is the same reasoning as the draw
 * plugin's preview collection turned up a notch: the grid is chrome, not data. Put
 * it in the store and it becomes selectable, snappable to (a grid line is an *edge*,
 * as far as the snap engine is concerned), undoable, and — worst — exported into the
 * level file, which would ship 256 line features describing a number the game already
 * knows.
 */
export function tileGridPlugin(options: GameOptions = {}): BlaeuPlugin<void, GameOptions> {
  return {
    id: 'game-grid',
    version: '1.0.0',

    dependencies: [
      // Hard: without a world plane there are no world units to draw a grid in.
      { id: 'game-world' },
      // Optional, and genuinely so: without snapping the grid is still drawn, and
      // entities land wherever the pointer is. See the degradation test.
      { id: 'snap', optional: true },
    ],

    setup(ctx: PluginContext<GameOptions>): void {
      const resolved = resolveGameOptions({ ...options, ...(ctx.options ?? {}) })
      const world = ctx.plugin('game-world')

      ctx.disposables.add(ctx.layers.registerType(createTileGridLayerType(ctx, resolved)))

      // A hex lattice is not a grid, and the snap plugin's grid provider — which is
      // square, in the working CRS, by contract — cannot express one. So we do not
      // ask it to: we register a *provider*, which is the extension point that exists
      // for exactly this. Every tool in the product now snaps to hex centres,
      // including tools written by someone who has never heard of this preset.
      if (resolved.gridType === 'hex') {
        const snap = ctx.tryPlugin('snap')
        if (snap) {
          ctx.disposables.add(snap.addProvider(createHexProvider(ctx, world, resolved)))
        } else {
          ctx.log.warn(
            'gridType is "hex" but the snap plugin is not installed, so entities will not land on ' +
              'hex centres. Install snapPlugin, or place entities through map.plugin("game-entity").place(), ' +
              'which snaps by itself.',
          )
        }
      }
    },
  }
}

/* ========================================================================= */
/* The layer type                                                            */
/* ========================================================================= */

function createTileGridLayerType(
  ctx: PluginContext<GameOptions>,
  defaults: ResolvedGameOptions,
): LayerTypeDef<TileGridConfig> {
  return {
    type: TILE_GRID_TYPE,

    create(spec: LayerSpec & { config?: TileGridConfig }): LayerInstance {
      const config = spec.config ?? {}
      const gridSize = config.gridSize ?? defaults.gridSize
      const gridType = config.gridType ?? defaults.gridType
      const bounds = config.bounds ?? defaults.bounds
      const maxCells = config.maxGridCells ?? defaults.maxGridCells

      if (!(gridSize > 0)) {
        throw new Error(
          `[preset-game] tile-grid layer "${spec.id}" has gridSize ${String(gridSize)}. ` +
            `It is the tile size in world units and must be positive.`,
        )
      }

      const transform = createWorldTransform(defaults.unitsPerDegree)
      const features =
        gridType === 'hex'
          ? hexFeatures(spec.id, bounds, gridSize, maxCells, transform)
          : squareFeatures(
              spec.id,
              bounds,
              gridSize,
              config.majorEvery ?? defaults.majorEvery,
              maxCells,
              transform,
            )

      const style = gridStyle(config, defaults)
      const source = ctx.renderer.addSource(spec.id, features)
      let layer: Disposable
      try {
        layer = ctx.renderer.addLayer(spec.id, spec.id, style, spec.beforeId)
      } catch (err) {
        // An orphaned source outlives the map and nothing will ever release it.
        source.dispose()
        throw err
      }

      let disposed = false

      return {
        id: spec.id,
        type: TILE_GRID_TYPE,
        setVisible: (visible) => ctx.renderer.setLayerVisible(spec.id, visible),
        setStyle: (next: LayerStyle) => ctx.renderer.setLayerStyle(spec.id, next),
        dispose: () => {
          // Idempotent: `LayerManager.remove()` and `ctx.disposables` both reach for
          // this, and removing a layer twice throws in MapLibre.
          if (disposed) return
          disposed = true
          layer.dispose()
          source.dispose()
        },
      }
    },
  }
}

function gridStyle(config: TileGridConfig, defaults: ResolvedGameOptions): LayerStyle {
  const width = config.lineWidth ?? defaults.gridLineWidth
  return {
    line: {
      color: config.color ?? defaults.gridColor,
      opacity: config.opacity ?? defaults.gridOpacity,
      // Major lines are the same layer, twice the weight — a `case` expression rather
      // than a second layer, because two layers means two sources means the grid
      // uploads itself to the GPU twice.
      width: ['case', ['get', MAJOR_PROPERTY], width * 2, width],
    },
  }
}

/* ========================================================================= */
/* Geometry                                                                  */
/* ========================================================================= */

interface Transform {
  toLngLat(xy: readonly [number, number]): LngLat
}

function gridFeature(
  id: string,
  collection: string,
  path: readonly (readonly [number, number])[],
  transform: Transform,
  major: boolean,
): BlaeuFeature {
  const now = 0
  return {
    id,
    geometry: {
      type: 'LineString',
      coordinates: path.map((xy) => [...transform.toLngLat(xy)]),
    },
    properties: { [MAJOR_PROPERTY]: major },
    // Timestamps are frozen at 0 rather than `Date.now()`: these features are
    // regenerated identically on every layer rebuild (a `move()` does exactly that),
    // and a snapshot test that diffed them would otherwise fail on the clock.
    meta: { collection, version: 1, createdAt: now, updatedAt: now },
  }
}

function squareFeatures(
  layerId: string,
  bounds: WorldBbox,
  gridSize: number,
  majorEvery: number,
  maxCells: number,
  transform: Transform,
): readonly BlaeuFeature[] {
  const [minX, minY, maxX, maxY] = bounds
  const firstColumn = Math.ceil(minX / gridSize)
  const lastColumn = Math.floor(maxX / gridSize)
  const firstRow = Math.ceil(minY / gridSize)
  const lastRow = Math.floor(maxY / gridSize)

  const lines = lastColumn - firstColumn + 1 + (lastRow - firstRow + 1)
  assertWithinBudget(lines, maxCells, gridSize, bounds)

  const features: BlaeuFeature[] = []

  for (let column = firstColumn; column <= lastColumn; column++) {
    const x = column * gridSize
    features.push(
      gridFeature(
        `${layerId}:v${column}`,
        layerId,
        [
          [x, minY],
          [x, maxY],
        ],
        transform,
        isMajor(column, majorEvery),
      ),
    )
  }

  for (let row = firstRow; row <= lastRow; row++) {
    const y = row * gridSize
    features.push(
      gridFeature(
        `${layerId}:h${row}`,
        layerId,
        [
          [minX, y],
          [maxX, y],
        ],
        transform,
        isMajor(row, majorEvery),
      ),
    )
  }

  return features
}

function hexFeatures(
  layerId: string,
  bounds: WorldBbox,
  gridSize: number,
  maxCells: number,
  transform: Transform,
): readonly BlaeuFeature[] {
  const centres = hexCentresIn(bounds, gridSize)
  assertWithinBudget(centres.length, maxCells, gridSize, bounds)

  // One closed LineString per cell. Six shared edges are drawn twice, which is a
  // real cost and the right trade: de-duplicating them means a half-edge data
  // structure, and at a few thousand cells the GPU does not notice while the reader
  // of this file certainly would.
  return centres.map((centre, index) =>
    gridFeature(`${layerId}:hex${index}`, layerId, hexRing(centre, gridSize), transform, false),
  )
}

function isMajor(index: number, majorEvery: number): boolean {
  return majorEvery > 0 && index % majorEvery === 0
}

function assertWithinBudget(
  count: number,
  maxCells: number,
  gridSize: number,
  bounds: WorldBbox,
): void {
  if (count <= maxCells) return
  throw new Error(
    `[preset-game] a ${gridSize}-unit grid over [${bounds.join(', ')}] needs ${count} features, ` +
      `over the maxGridCells budget of ${maxCells}. Raise maxGridCells if you mean it, or — far more likely — ` +
      `raise gridSize or shrink bounds. (A grid this dense is invisible at any zoom that shows the whole world, ` +
      `so it costs a hang and buys nothing.)`,
  )
}

/* ========================================================================= */
/* Hex snapping                                                              */
/* ========================================================================= */

/**
 * A snap provider for hex centres — the kernel's `SnapProvider` extension point,
 * used for a target the kernel could not have anticipated.
 *
 * Priority 10, the same floor the built-in grid sits at: a hex centre exists
 * *everywhere*, so anything real (a vertex of a drawn zone, another entity) must
 * outrank it, or a level designer could never snap two entities to a shared corner.
 */
function createHexProvider(
  ctx: PluginContext<GameOptions>,
  world: WorldApi,
  options: ResolvedGameOptions,
): SnapProvider {
  return {
    id: HEX_SNAP_KIND,
    priority: 10,

    query(point: LngLat, tolerancePx: number, query: SnapQueryContext): readonly SnapCandidate[] {
      const centre = nearestHexCentre(world.toWorld(point), options.gridSize)
      const lngLat = world.toLngLat(centre)

      // Measured in **pixels**, not world units: "close" means close on screen, and a
      // tolerance in world units would snap from a mile away when zoomed out.
      const from = query.project(point)
      const to = query.project(lngLat)
      const distancePx = Math.hypot(to.x - from.x, to.y - from.y)
      if (distancePx > tolerancePx) return []

      return [
        {
          kind: HEX_SNAP_KIND,
          point: lngLat,
          distancePx,
          priority: 10,
          hint: ctx.i18n.t('snap.kind.hex-centre'),
        },
      ]
    },
  }
}
