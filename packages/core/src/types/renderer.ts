import type { Bbox, Disposable, LngLat, ScreenPoint } from './common.js'
import type { BlaeuFeature } from './feature.js'
import type { InteractionConfig } from './config.js'

export interface Camera {
  readonly center: LngLat
  readonly zoom: number
  readonly bearing: number
  readonly pitch: number
}

export interface CameraOptions extends Partial<Camera> {
  readonly duration?: number
  readonly padding?: number | { top: number; bottom: number; left: number; right: number }
}

/** Renderer-agnostic style. Concrete renderers translate this into their own language. */
export interface LayerStyle {
  readonly fill?: {
    color?: string | unknown[]
    opacity?: number | unknown[]
    outlineColor?: string | unknown[]
  }
  readonly line?: {
    color?: string | unknown[]
    width?: number | unknown[]
    opacity?: number | unknown[]
    dasharray?: readonly number[]
  }
  readonly circle?: {
    color?: string | unknown[]
    radius?: number | unknown[]
    strokeColor?: string | unknown[]
    strokeWidth?: number | unknown[]
  }
  readonly symbol?: {
    icon?: string
    text?: string | unknown[]
    size?: number | unknown[]
  }
  /**
   * Renderer-specific overrides, applied last.
   *
   * The abstraction above covers what's portable across renderers. This is the
   * pressure valve for everything that isn't — MapLibre `paint`/`layout` keys,
   * deck.gl props. Using it couples that layer to a renderer, which is a real
   * cost, but it beats the alternative of a leaky abstraction that pretends every
   * renderer is the same one.
   */
  readonly native?: Record<string, unknown>
}

/** Emitted by the renderer, consumed by the interaction pipeline. */
export interface RendererPointerEvent {
  readonly kind: 'pointerdown' | 'pointermove' | 'pointerup' | 'click' | 'dblclick'
  readonly lngLat: LngLat
  readonly screen: ScreenPoint
  /** Which button changed for this event (0 = primary). */
  readonly button: number
  /**
   * The bitmask of buttons **currently held** (0 = none), as on a DOM MouseEvent. A
   * `pointermove` that arrives with `buttons === 0` means the button was released where the
   * canvas could not see it — off-canvas — so no `pointerup` was delivered. A drag tool watches
   * for it to end a gesture that would otherwise chase the cursor forever. Undefined for a touch
   * stream, which has no button bitmask (and whose `touchend` fires even off the canvas).
   */
  readonly buttons?: number
  readonly modifiers: {
    readonly shift: boolean
    readonly ctrl: boolean
    readonly alt: boolean
    readonly meta: boolean
  }
  readonly originalEvent: Event
}

/**
 * The rendering abstraction.
 *
 * MapLibre is the only implementation we ship, and it's the right default. But
 * the interface exists so that a Three.js renderer for a 2.5D game map, or a
 * headless one for server-side rendering and tests, is a *new package* rather
 * than a fork. The `FakeRenderer` in `@blaeu/core/testing` is the proof that
 * the seam is real: the entire test suite runs against it with no GPU.
 *
 * Deliberately small. Anything that can be built on top of these primitives —
 * measurement, highlighting, editing handles — is a plugin, not a renderer
 * method.
 */
export interface Renderer {
  /** `'maplibre'`, `'fake'`, `'threejs'`… Plugins can branch on it if they must. */
  readonly kind: string

  mount(container: HTMLElement): Promise<void>

  /* --- coordinate transforms. Must be exact inverses of each other. --- */
  project(lngLat: LngLat): ScreenPoint
  unproject(point: ScreenPoint): LngLat

  /* --- data --- */
  setData(sourceId: string, features: readonly BlaeuFeature[]): void
  addSource(sourceId: string, features?: readonly BlaeuFeature[]): Disposable
  removeSource(sourceId: string): void

  /* --- layers --- */
  addLayer(layerId: string, sourceId: string, style: LayerStyle, beforeId?: string): Disposable
  removeLayer(layerId: string): void
  setLayerStyle(layerId: string, style: LayerStyle): void
  setLayerVisible(layerId: string, visible: boolean): void

  /**
   * Swap the basemap at runtime — the primitive a theme change drives.
   *
   * Optional: a renderer for a fixed-ground game map may have no basemap to swap. A
   * renderer that *does* implement it must survive the swap — some renderers (MapLibre
   * among them) tear down every source and layer on a style change, so the
   * implementation is responsible for re-materialising the ones this library added,
   * with their data and stacking order, or a theme change would wipe the map. The
   * camera must not move. Callers probe for the method rather than assuming it.
   */
  setBasemap?(style: string | Record<string, unknown>): Promise<void>

  /**
   * Hand the renderer the resolved interaction config — which of pan, scroll-zoom,
   * double-click-zoom and keyboard navigation are live.
   *
   * Optional: a renderer with no built-in gesture handling (a fixed game board, a headless
   * test double that only needs projection) has nothing to toggle. The kernel calls it once
   * after mount and probes for the method rather than assuming it. `dragThreshold` travels in
   * the config but is the interaction *pipeline's* notion of when a press becomes a drag, not
   * the renderer's — an implementation should ignore it rather than invent an equivalent.
   */
  setInteraction?(interaction: Partial<InteractionConfig>): void

  /* --- camera --- */
  getCamera(): Camera
  setCamera(options: CameraOptions): void
  fitBounds(bbox: Bbox, options?: { padding?: number; duration?: number }): void

  /* --- hit testing --- */
  queryAt(point: ScreenPoint, layerIds?: readonly string[]): readonly BlaeuFeature[]
  queryInBox(a: ScreenPoint, b: ScreenPoint, layerIds?: readonly string[]): readonly BlaeuFeature[]

  /* --- events --- */
  onPointer(handler: (event: RendererPointerEvent) => void): Disposable
  onCamera(handler: (camera: Camera, moving: boolean) => void): Disposable

  setCursor(cursor: string): void

  /**
   * The sanctioned escape hatch (core invariant 6).
   *
   * ```ts
   * const maplibre = map.renderer.getNative<maplibregl.Map>()
   * maplibre.addControl(new maplibregl.NavigationControl())
   * ```
   *
   * We *want* people to reach the underlying map — the alternative is that they
   * fork the library the first time we haven't wrapped something. But it is
   * explicit, greppable, and carries a warning: you are outside the abstraction,
   * and we cannot undo/redo what you do here.
   */
  getNative<T = unknown>(): T

  destroy(): void
}
