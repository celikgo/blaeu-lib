import type { CollectionId, Disposable } from '../types/common.js'
import type { LayerInstance, LayerTypeDef } from '../types/extensions.js'
import type { LayerStyle, Renderer } from '../types/renderer.js'

/**
 * The built-in `vector` layer type: one store collection, drawn with one style.
 *
 * It is deliberately thin, because the interesting decisions are elsewhere. The
 * collection → renderer-source mapping is 1:1 and owned by the layer *manager*
 * (which ref-counts it, so a fill layer and an outline layer over the same
 * `parcels` collection share one source rather than duplicating every feature on
 * the GPU), and the feature data itself arrives via `LayerManager.connectStore()`.
 *
 * What is left here is: take a source, take a style, put a layer on the map.
 *
 * @param acquireSource - hands back a ref-counted renderer source for a
 *   collection, and a `Disposable` that releases *this layer's* claim on it.
 */
export function createVectorLayerType(
  renderer: Renderer,
  acquireSource: (collection: CollectionId) => Disposable,
): LayerTypeDef {
  return {
    type: 'vector',

    create(spec): LayerInstance {
      const collection: CollectionId | undefined = spec.source
      if (collection === undefined || collection === '') {
        throw new Error(
          `[blaeu] vector layer "${spec.id}" has no "source". ` +
            `A vector layer renders one store collection, so it needs the collection id — ` +
            `e.g. { id: "${spec.id}", type: "vector", source: "parcels" }. ` +
            `Use type "raster" for a layer with no store data behind it.`,
        )
      }

      const sourceRef = acquireSource(collection)
      let layerRef: Disposable
      try {
        layerRef = renderer.addLayer(spec.id, collection, spec.style ?? {}, spec.beforeId)
      } catch (err) {
        // The source claim must not outlive a failed layer, or a typo in a style
        // leaves an orphan source that nothing will ever release.
        sourceRef.dispose()
        throw err
      }

      let disposed = false

      return {
        id: spec.id,
        type: 'vector',

        setVisible(visible: boolean): void {
          renderer.setLayerVisible(spec.id, visible)
        },

        setStyle(style: LayerStyle): void {
          renderer.setLayerStyle(spec.id, style)
        },

        dispose(): void {
          // Idempotent: `LayerManager.remove()` and a plugin's `ctx.disposables`
          // will both reach for this, and asking a renderer to remove a layer twice
          // throws in MapLibre.
          if (disposed) return
          disposed = true
          layerRef.dispose()
          sourceRef.dispose()
        },
      }
    },
  }
}
