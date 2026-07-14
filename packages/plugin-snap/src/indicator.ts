import type {
  Disposable,
  FlexiFeature,
  LayerStyle,
  Renderer,
  SnapResult,
  ThemeManager,
} from '@fleximap/core'
import { INDICATOR_LAYER, INDICATOR_SOURCE } from './constants.js'

/**
 * The mark under the cursor that says *this is where the vertex will land*.
 *
 * ## Why it is not in the feature store
 *
 * It is a cursor decoration, not data. Putting it in the store would work — a
 * transient command would even keep it out of the undo stack — but it would put a
 * feature in `store.snapshot()`, and `store.snapshot()` is what the undo round-trip
 * test compares for *deep equality*. Every plugin in the repo would then find that
 * its undo test passes or fails depending on where the mouse happened to be, which
 * is a horrible property for a test suite to have, and a worse one for a
 * collaboration plugin diffing snapshots to produce a patch: the indicator would go
 * over the wire.
 *
 * So it lives one level down, as its own renderer source and its own layer, built
 * through the public {@link Renderer} contract. It composes exactly like any other
 * layer, it is disposed with the plugin, and the store never hears about it.
 *
 * It is styled entirely from theme tokens — `color.snapIndicator`,
 * `size.snapIndicatorRadius` — so that the amber ring on the map is the same amber
 * the toolbar uses, and a preset can restyle both by changing one value.
 */
export class SnapIndicator {
  readonly #renderer: Renderer
  readonly #theme: ThemeManager

  #source: Disposable | undefined
  #layer: Disposable | undefined
  #themeSub: Disposable | undefined
  #shown = false
  #disposed = false

  constructor(renderer: Renderer, theme: ThemeManager) {
    this.#renderer = renderer
    this.#theme = theme
  }

  /** Adds the source and layer. Returns the handle that takes them away again. */
  mount(): Disposable {
    this.#source = this.#renderer.addSource(INDICATOR_SOURCE, [])
    this.#layer = this.#renderer.addLayer(INDICATOR_LAYER, INDICATOR_SOURCE, this.#style())
    this.#themeSub = this.#theme.onChange(() => {
      if (this.#disposed) return
      this.#renderer.setLayerStyle(INDICATOR_LAYER, this.#style())
    })

    return { dispose: () => this.dispose() }
  }

  /** Draw the mark, or clear it when nothing is snapped. */
  render(result: SnapResult | undefined): void {
    if (this.#disposed) return

    if (result === undefined) {
      // Only *after* something was shown: a `setData` per pointer move across empty
      // ground is a wasted GPU upload sixty times a second, and there is nothing to
      // clear.
      if (!this.#shown) return
      this.#shown = false
      this.#renderer.setData(INDICATOR_SOURCE, [])
      return
    }

    this.#shown = true
    this.#renderer.setData(INDICATOR_SOURCE, [toFeature(result)])
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true

    this.#themeSub?.dispose()
    // Layer before source: a renderer asked to drop a source still referenced by a
    // layer is a renderer being asked to draw from nothing, and MapLibre says so
    // loudly.
    this.#layer?.dispose()
    this.#source?.dispose()

    this.#themeSub = undefined
    this.#layer = undefined
    this.#source = undefined
    this.#shown = false
  }

  #style(): LayerStyle {
    const color = this.#theme.token('color')
    const size = this.#theme.token('size')

    return {
      circle: {
        color: color.snapIndicator,
        radius: size.snapIndicatorRadius,
        // A halo in the surface colour, so the mark reads on a dark satellite
        // basemap and on a white cadastral one without the theme having to know
        // which it is.
        strokeColor: color.surface,
        strokeWidth: 2,
      },
    }
  }
}

/**
 * The indicator as a renderer feature.
 *
 * The `kind` and `hint` ride along in `properties` so that a UI plugin can style by
 * snap kind (a square for a grid, a triangle for an intersection) or show the hint
 * as a tooltip — without the snap plugin knowing that any UI exists.
 */
function toFeature(result: SnapResult): FlexiFeature {
  const { candidate } = result
  const now = Date.now()

  return {
    id: INDICATOR_SOURCE,
    geometry: { type: 'Point', coordinates: [candidate.point[0], candidate.point[1]] },
    properties: {
      kind: candidate.kind,
      ...(candidate.hint !== undefined ? { hint: candidate.hint } : {}),
    },
    meta: {
      collection: INDICATOR_SOURCE,
      version: 1,
      createdAt: now,
      updatedAt: now,
      source: 'snap',
    },
  }
}
