import type { LayerSpec } from '@fleximap/core'

import type { ResolvedGameOptions } from './types.js'
import { TILE_GRID_TYPE } from './plugins/tileGrid.js'
import { entityStyle, zoneStyle } from './styles.js'
import { entityCollections } from './options.js'

/**
 * The layer stack, bottom to top: grid, zones, entities.
 *
 * The grid is a `tile-grid` layer — a layer *type* this preset registers itself,
 * not one the core ships. That is the whole demonstration: `vector` and `raster`
 * are the only categories the kernel knows about, and a domain that needs a third
 * one adds it without the core changing. A deck.gl plugin would add `deckgl`
 * exactly this way.
 *
 * Entities go last so a placed tree is clickable over the zone beneath it. Layer
 * order is paint order, and a level designer who cannot select the thing they can
 * see will (rightly) file it as a bug.
 */
export function gameLayers(o: ResolvedGameOptions): readonly LayerSpec[] {
  const layers: LayerSpec[] = [
    {
      id: 'game-grid',
      type: TILE_GRID_TYPE,
      config: {
        gridSize: o.gridSize,
        gridType: o.gridType,
        bounds: o.bounds,
        color: o.gridColor,
        opacity: o.gridOpacity,
        lineWidth: o.gridLineWidth,
        majorEvery: o.majorEvery,
        maxGridCells: o.maxGridCells,
      },
    },
  ]

  if (o.zones) {
    layers.push({
      id: 'game-zones',
      type: 'vector',
      source: o.zoneCollection,
      style: zoneStyle(o),
    })
  }

  // One layer per entity collection. Most levels use exactly one; an EntityType may
  // opt into its own layer when it needs to paint above or below the rest (a
  // spawn marker that must never be hidden behind a rock).
  for (const collection of entityCollections(o)) {
    layers.push({
      id: `game-entities-${collection}`,
      type: 'vector',
      source: collection,
      style: entityStyle(o),
    })
  }

  return layers
}
