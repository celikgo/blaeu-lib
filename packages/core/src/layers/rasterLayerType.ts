import type { LayerInstance, LayerTypeDef } from '../types/extensions.js'
import type { LayerStyle, Renderer } from '../types/renderer.js'

/** Config for the built-in `raster` layer type: an XYZ/WMTS tile set. */
export interface RasterLayerConfig {
  /** XYZ tile URL templates, e.g. `https://…/{z}/{x}/{y}.png`. At least one. */
  readonly tiles: readonly string[]
  /** Pixel size of a tile. 256 for classic XYZ; 512 for most modern basemaps. */
  readonly tileSize?: number
  /** Rendered in the map's attribution control. Usually legally required — pass it. */
  readonly attribution?: string
  readonly minzoom?: number
  readonly maxzoom?: number
}

const DEFAULT_TILE_SIZE = 256

/**
 * The built-in `raster` layer type: a basemap, an orthophoto, a scanned cadastral
 * sheet.
 *
 * Note what it does *not* do: it never touches the feature store, and it never
 * calls `renderer.addSource()`. The `Renderer` contract's `addSource` speaks
 * {@link FlexiFeature}s — it is a vector-data primitive — and inventing a second
 * source primitive on the renderer purely for tiles would enlarge the abstraction
 * for one case.
 *
 * So the tile source travels to the renderer inside `style.native`, which is
 * exactly what `native` is for: the renderer-specific pressure valve. The renderer
 * is responsible for materialising `native.source` before it adds `native.type`.
 * The shape is fixed here, and it is MapLibre-shaped because MapLibre is the
 * renderer we ship:
 *
 * ```jsonc
 * {
 *   "type": "raster",
 *   "source": { "type": "raster", "tiles": ["…/{z}/{x}/{y}.png"], "tileSize": 256 }
 * }
 * ```
 */
export function createRasterLayerType(renderer: Renderer): LayerTypeDef<RasterLayerConfig> {
  return {
    type: 'raster',

    create(spec): LayerInstance {
      const config = spec.config
      const tiles = config?.tiles
      if (!Array.isArray(tiles) || tiles.length === 0 || !tiles.every(isNonEmptyString)) {
        throw new Error(
          `[fleximap] raster layer "${spec.id}" needs config.tiles: a non-empty array of XYZ URL templates. ` +
            `e.g. { id: "${spec.id}", type: "raster", config: { tiles: ["https://tile.example/{z}/{x}/{y}.png"], attribution: "© Example" } }`,
        )
      }

      // A raster layer's source is its own, not a shared store collection, so it is
      // named after the layer unless the caller deliberately points several layers
      // at one tile set.
      const sourceId = spec.source ?? spec.id

      const style: LayerStyle = {
        ...spec.style,
        native: {
          type: 'raster',
          source: {
            type: 'raster',
            tiles: [...tiles],
            tileSize: config?.tileSize ?? DEFAULT_TILE_SIZE,
            ...(config?.attribution !== undefined ? { attribution: config.attribution } : {}),
            ...(config?.minzoom !== undefined ? { minzoom: config.minzoom } : {}),
            ...(config?.maxzoom !== undefined ? { maxzoom: config.maxzoom } : {}),
          },
          // Caller's `native` wins, so a paint override (raster-opacity, saturation)
          // is still reachable without re-declaring the source.
          ...spec.style?.native,
        },
      }

      const layerRef = renderer.addLayer(spec.id, sourceId, style, spec.beforeId)
      let disposed = false
      let current = style

      return {
        id: spec.id,
        type: 'raster',

        setVisible(visible: boolean): void {
          renderer.setLayerVisible(spec.id, visible)
        },

        setStyle(next: LayerStyle): void {
          // Re-stamp `native.source`: a caller restyling the layer (bumping
          // raster-opacity, say) is not thinking about the tile source, and dropping
          // it here would leave the renderer holding a layer whose source vanished.
          current = { ...next, native: { ...current.native, ...next.native } }
          renderer.setLayerStyle(spec.id, current)
        },

        dispose(): void {
          if (disposed) return
          disposed = true
          layerRef.dispose()
          renderer.removeSource(sourceId)
        },
      }
    },
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
