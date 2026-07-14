import { DisposableStore } from '@fleximap/core'
import type {
  Disposable,
  FlexiFeature,
  Geometry,
  LayerStyle,
  LngLat,
  PluginContext,
  ThemeTokens,
} from '@fleximap/core'

/**
 * Renderer sources and layers, **not** store collections.
 *
 * This is the whole transient/committed distinction made concrete. A selection is
 * view state: it is not exported, not validated, not versioned, and above all not
 * undoable. Putting the highlight geometry in the store would make it document
 * state — the commit pipeline would validate it, `toGeoJSON()` would serialise it,
 * and a `snapshot()`/`restore()` round-trip would try to bring it back. So the
 * overlay talks to the renderer directly and the store never hears about it.
 */
export const HIGHLIGHT_SOURCE = 'select:highlight'
export const HIGHLIGHT_LAYER = 'select:highlight'
export const PREVIEW_SOURCE = 'select:preview'
export const PREVIEW_LAYER = 'select:preview'

/** The id of the synthetic marquee/lasso feature. Never in the store; see `SelectionController.pick`. */
const PREVIEW_ID = 'select:preview-shape'

export class SelectionOverlay implements Disposable {
  readonly #ctx: PluginContext<unknown>
  readonly #disposables = new DisposableStore()
  #visible = true

  constructor(ctx: PluginContext<unknown>) {
    this.#ctx = ctx

    // A vector layer over a source with no store collection behind it: `LayerManager`
    // acquires the renderer source for us (and releases it on dispose), while the
    // data is pushed by hand from `setSelected`/`setPreview`. `connectStore()` never
    // touches these sources, because the store has no collection by these names.
    this.#disposables.add(
      ctx.layers.add({
        id: HIGHLIGHT_LAYER,
        type: 'vector',
        source: HIGHLIGHT_SOURCE,
        style: highlightStyle(ctx.theme.token('color'), ctx.theme.token('size')),
      }),
    )
    this.#disposables.add(
      ctx.layers.add({
        id: PREVIEW_LAYER,
        type: 'vector',
        source: PREVIEW_SOURCE,
        style: previewStyle(ctx.theme.token('color'), ctx.theme.token('size')),
      }),
    )

    this.#disposables.add(
      ctx.theme.onChange((theme) => {
        // Read through the theme rather than hardcoding a blue: the selection halo on
        // the map and the selected row in an attribute table are then the same colour
        // by construction, not by two people agreeing on a hex code.
        ctx.layers
          .get(HIGHLIGHT_LAYER)
          ?.setStyle(highlightStyle(theme.tokens.color, theme.tokens.size))
        ctx.layers.get(PREVIEW_LAYER)?.setStyle(previewStyle(theme.tokens.color, theme.tokens.size))
      }),
    )

    // Plugins are set up *before* the preset's and the user's layers are added, so a
    // layer created in `setup` starts underneath them and the highlight would be
    // painted over by the very features it is highlighting. `map:ready` fires after
    // every declared layer exists, which is the first moment "on top" is meaningful.
    // (Installed at runtime instead, the layer is already on top and this never fires.)
    this.#disposables.add(
      ctx.events.on('map:ready', () => {
        ctx.layers.move(HIGHLIGHT_LAYER)
        ctx.layers.move(PREVIEW_LAYER)
      }),
    )
  }

  setSelected(features: readonly FlexiFeature[]): void {
    this.#ctx.renderer.setData(HIGHLIGHT_SOURCE, features)
  }

  setPreview(ring: readonly LngLat[]): void {
    if (ring.length < 2) {
      this.clearPreview()
      return
    }
    // A LineString, not a Polygon: a half-drawn lasso is not a valid ring, and a
    // renderer asked to fill a self-intersecting one draws something alarming.
    const geometry: Geometry = { type: 'LineString', coordinates: ring.map((p) => [p[0], p[1]]) }
    this.#ctx.renderer.setData(PREVIEW_SOURCE, [previewFeature(geometry)])
  }

  clearPreview(): void {
    this.#ctx.renderer.setData(PREVIEW_SOURCE, [])
  }

  /** `disable()` hides the overlay without forgetting the selection. */
  setVisible(visible: boolean): void {
    if (this.#visible === visible) return
    this.#visible = visible
    this.#ctx.layers.get(HIGHLIGHT_LAYER)?.setVisible(visible)
    this.#ctx.layers.get(PREVIEW_LAYER)?.setVisible(visible)
  }

  dispose(): void {
    this.#disposables.dispose()
  }
}

/** Synthetic, renderer-only. It carries a `meta` because `FlexiFeature` requires one, not because anything reads it. */
function previewFeature(geometry: Geometry): FlexiFeature {
  return {
    id: PREVIEW_ID,
    geometry,
    properties: {},
    meta: { collection: PREVIEW_SOURCE, version: 0, createdAt: 0, updatedAt: 0 },
  }
}

function highlightStyle(color: ThemeTokens['color'], size: ThemeTokens['size']): LayerStyle {
  return {
    fill: { color: color.selection, opacity: 0.25, outlineColor: color.selection },
    // Wider than the base line width, so a selected boundary reads as selected even
    // where it lies exactly on top of an unselected neighbour's shared edge.
    line: { color: color.selection, width: size.lineWidth + 2 },
    circle: {
      color: color.selection,
      radius: size.vertexRadius,
      strokeColor: color.surface,
      strokeWidth: 1.5,
    },
  }
}

function previewStyle(color: ThemeTokens['color'], size: ThemeTokens['size']): LayerStyle {
  return {
    line: { color: color.selection, width: size.lineWidth, dasharray: [2, 2] },
  }
}
