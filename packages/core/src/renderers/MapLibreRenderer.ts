import type { Feature, FeatureCollection } from 'geojson'
import type {
  EaseToOptions,
  FitBoundsOptions,
  GeoJSONSource,
  JumpToOptions,
  LayerSpecification,
  Map as MapLibreMap,
  MapGeoJSONFeature,
  MapMouseEvent,
  MapOptions,
  MapTouchEvent,
  PaddingOptions,
  StyleSpecification,
  Subscription,
} from 'maplibre-gl'

import type { Bbox, Disposable, FeatureId, LngLat, ScreenPoint } from '../types/common.js'
import type { BlaeuFeature } from '../types/feature.js'
import type { InteractionConfig } from '../types/config.js'
import type {
  Camera,
  CameraOptions,
  LayerStyle,
  Renderer,
  RendererPointerEvent,
} from '../types/renderer.js'

/* ========================================================================= */
/* Reserved GeoJSON property keys                                            */
/* ========================================================================= */

/**
 * The `$`-prefixed keys BlaeuMap writes into the GeoJSON it hands MapLibre.
 *
 * A `BlaeuFeature.meta` block is *ours* — collection, version, timestamps, plugin
 * scratch space — and shipping it into `properties` wholesale would mean a
 * round-trip through the renderer silently leaks our internals into anything that
 * reads the source back out, and collides the day a cadastral schema legitimately
 * has a column called `version` (`feature.ts` says as much, and it is right).
 *
 * But the renderer genuinely needs three things from `meta` to do its job: the id,
 * and the two flags a style expression will want to branch on. So exactly those
 * three cross the boundary, under keys that are namespaced loudly enough that a
 * collision with a real attribute is a deliberate act.
 */
export const ID_PROPERTY = '$id'
export const LOCKED_PROPERTY = '$locked'
export const HIDDEN_PROPERTY = '$hidden'

/* ========================================================================= */
/* Options                                                                   */
/* ========================================================================= */

export interface MapLibreRendererOptions {
  /**
   * A MapLibre style URL or inline style. Defaults to an empty style — see
   * {@link blankStyle}.
   */
  readonly style?: string | StyleSpecification

  /**
   * MapLibre's own gesture handlers, driven from the kernel's `InteractionConfig`.
   *
   * The map owner decides this, not the renderer: a cadastre preset turns
   * `doubleClickZoom` off because double-click closes a ring, and a game preset
   * leaves it on. All the renderer does is carry the decision across to MapLibre.
   */
  readonly interaction?: Partial<InteractionConfig>

  /**
   * Passed straight to MapLibre's `Map` constructor (minus `container` and `style`,
   * which we own). The place for `maxZoom`, `attributionControl`, `locale`, `hash`.
   */
  readonly mapOptions?: Omit<MapOptions, 'container' | 'style'>
}

/**
 * An empty, self-contained style.
 *
 * Deliberately **not** MapLibre's `demotiles` URL. A default that reaches for the
 * network is a default that fails in a government intranet, in a test runner, and
 * on a surveyor's laptop in a field with no signal — and it fails *slowly*, as a
 * hang rather than an error. An empty style renders a blank canvas, which is
 * honest: the host app has not told us what basemap it wants yet.
 *
 * Freshly constructed on every call because MapLibre mutates the style object it is
 * given; a shared literal handed to two maps is an aliasing bug waiting for the
 * second map.
 *
 * Note there is no `glyphs` or `sprite` endpoint here — there is no offline glyph
 * source we could bundle. A `symbol` layer with `text` needs a style that provides
 * one, or MapLibre will refuse the layer.
 */
export function blankStyle(): StyleSpecification {
  return { version: 8, sources: {}, layers: [] }
}

/* ========================================================================= */
/* Internal bookkeeping                                                      */
/* ========================================================================= */

type NativeLayerType = 'fill' | 'line' | 'circle' | 'symbol'

/**
 * Bottom to top. One BlaeuMap layer with `fill` *and* `line` is two MapLibre
 * layers, and the fill must sit under its own outline or the outline disappears.
 */
const SUBLAYERS: readonly NativeLayerType[] = ['fill', 'line', 'circle', 'symbol']

/** Which MapLibre paint/layout keys belong to which sublayer. */
const KEY_PREFIXES: Readonly<Record<NativeLayerType, readonly string[]>> = {
  fill: ['fill-'],
  line: ['line-'],
  circle: ['circle-'],
  symbol: ['icon-', 'text-', 'symbol-'],
}

/** Structural keys the caller may not override through `style.native`. */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set(['id', 'type', 'source', 'paint', 'layout'])

interface NativeLayer {
  readonly id: string
  readonly type: NativeLayerType
  readonly paint: Record<string, unknown>
  readonly layout: Record<string, unknown>
  /** `filter`, `minzoom`, `maxzoom`, `metadata` — anything `native` set at layer level. */
  readonly extra: Record<string, unknown>
}

interface LayerEntry {
  readonly sourceId: string
  readonly beforeId: string | undefined
  style: LayerStyle
  visible: boolean
  native: NativeLayer[]
}

const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_PX = 30

/* ========================================================================= */
/* The renderer                                                              */
/* ========================================================================= */

/**
 * The MapLibre implementation of {@link Renderer}.
 *
 * It is the only renderer we ship and the right default, but it is *an*
 * implementation, not *the* implementation — the seam exists so that a Three.js
 * renderer for a 2.5D game map is a new package rather than a fork, and so that the
 * test suite can run the whole library on a `FakeRenderer` with no GPU.
 *
 * Two things in here are load-bearing and non-obvious. Both are documented at the
 * method that owns them, and both are the kind of thing that silently half-works
 * until it doesn't:
 *
 * - **String feature ids.** MapLibre's GeoJSON source will not keep a non-numeric
 *   feature id unless you tell it to. See {@link addSource}.
 * - **Hit testing returns ids, not features.** A `MapGeoJSONFeature` is not a
 *   `BlaeuFeature` and cannot be turned into one. See {@link setFeatureResolver}.
 */
export class MapLibreRenderer implements Renderer {
  readonly kind = 'maplibre'

  readonly #style: string | StyleSpecification
  readonly #mapOptions: Omit<MapOptions, 'container' | 'style'> | undefined

  #interaction: Partial<InteractionConfig> | undefined
  #map: MapLibreMap | undefined
  #mounting: Promise<void> | undefined

  readonly #sources = new Set<string>()
  /**
   * The last data pushed to each source, kept so a basemap swap can re-materialise it.
   * `map.setStyle()` deletes every source and layer; without this we would re-add
   * empty sources and the map would go blank on a theme change.
   */
  readonly #sourceData = new Map<string, readonly BlaeuFeature[]>()
  readonly #layers = new Map<string, LayerEntry>()

  readonly #pointerHandlers = new Set<(event: RendererPointerEvent) => void>()
  readonly #cameraHandlers = new Set<(camera: Camera, moving: boolean) => void>()
  #subscriptions: Subscription[] = []

  #resolveFeature: ((id: FeatureId) => BlaeuFeature | undefined) | undefined
  #warnedMissingResolver = false

  /** Held so a `setCursor` issued before `mount()` is not silently lost. */
  #cursor = ''
  #lastTap: { at: number; x: number; y: number } | undefined
  #destroyed = false

  constructor(options: MapLibreRendererOptions = {}) {
    this.#style = options.style ?? blankStyle()
    this.#mapOptions = options.mapOptions
    this.#interaction = options.interaction
  }

  /* ---------------------------------------------------------------- mount */

  async mount(container: HTMLElement): Promise<void> {
    if (this.#destroyed) {
      throw new Error(
        '[blaeu] MapLibreRenderer.mount() called after destroy(). A renderer is not reusable — construct a new one.',
      )
    }
    // Idempotent: BlaeuMap awaits this once, but a caller who awaits `whenReady()`
    // twice must not get two MapLibre instances fighting over one container.
    this.#mounting ??= this.#mount(container)
    return this.#mounting
  }

  async #mount(container: HTMLElement): Promise<void> {
    const maplibre = await loadMapLibre()

    const map = new maplibre.Map({
      ...this.#mapOptions,
      container,
      style: this.#style,
    })
    this.#map = map

    if (this.#interaction) applyInteraction(map, this.#interaction)
    this.#bind(map)
    if (this.#cursor !== '') map.getCanvas().style.cursor = this.#cursor

    await whenLoaded(map)
  }

  /**
   * Hand MapLibre's own gesture handlers the kernel's interaction config.
   *
   * `dragThreshold` is deliberately not passed on: it is *our* notion of when a
   * press becomes a drag, consumed by the interaction pipeline, and MapLibre has no
   * equivalent knob. Silently mapping it to something MapLibre-ish would make a
   * config value mean two different things.
   */
  setInteraction(interaction: Partial<InteractionConfig>): void {
    this.#interaction = interaction
    if (this.#map) applyInteraction(this.#map, interaction)
  }

  /* ----------------------------------------------------------- transforms */

  project(lngLat: LngLat): ScreenPoint {
    const point = this.#requireMap('project').project([lngLat[0], lngLat[1]])
    return { x: point.x, y: point.y }
  }

  unproject(point: ScreenPoint): LngLat {
    const lngLat = this.#requireMap('unproject').unproject([point.x, point.y])
    return [lngLat.lng, lngLat.lat]
  }

  /* ----------------------------------------------------------------- data */

  /**
   * Register a GeoJSON source.
   *
   * `promoteId` is the whole point of this method and the reason it is not a
   * one-liner. MapLibre's GeoJSON source drops a top-level `id` that is not an
   * integer (or a string that parses as one), because the vector-tile format it
   * converts to internally only has room for a uint64. Our {@link FeatureId} is a
   * string — a land registry's parcel number has leading zeros that are meaningful,
   * as `common.ts` explains — so on a naive source *every* feature arrives at the
   * renderer with `id: undefined`.
   *
   * The symptom is not an error. It is `setFeatureState` doing nothing, hover
   * highlighting never lighting up, and `queryRenderedFeatures` returning features
   * we cannot map back to the store. `promoteId` tells MapLibre to take the id from
   * a *property* instead, where a string survives — so we write the id to
   * `properties.$id` and point `promoteId` at it.
   */
  addSource(sourceId: string, features: readonly BlaeuFeature[] = []): Disposable {
    const map = this.#requireMap('addSource')
    if (map.getSource(sourceId)) {
      throw new Error(
        `[blaeu] addSource("${sourceId}") — a source with that id already exists. ` +
          `Call setData("${sourceId}", features) to replace its contents, or removeSource() first.`,
      )
    }

    map.addSource(sourceId, {
      type: 'geojson',
      data: toFeatureCollection(features),
      promoteId: ID_PROPERTY,
    })
    this.#sources.add(sourceId)
    this.#sourceData.set(sourceId, features)

    return { dispose: () => this.removeSource(sourceId) }
  }

  setData(sourceId: string, features: readonly BlaeuFeature[]): void {
    const map = this.#requireMap('setData')
    const source = map.getSource<GeoJSONSource>(sourceId)
    if (!source) {
      throw new Error(
        `[blaeu] setData("${sourceId}") — no such source. Call addSource("${sourceId}") before writing to it.`,
      )
    }
    if (source.type !== 'geojson') {
      throw new Error(
        `[blaeu] setData("${sourceId}") — that source is a "${source.type}" source, not a GeoJSON one. ` +
          `Only sources BlaeuMap created hold BlaeuFeatures.`,
      )
    }
    source.setData(toFeatureCollection(features))
    this.#sourceData.set(sourceId, features)
  }

  /**
   * Remove a source, and any layer still drawing from it.
   *
   * MapLibre throws if a layer still references the source. Making the caller
   * remember the ordering is a rule nobody remembers, and the punishment is a hard
   * throw in the middle of teardown — which strands the disposables behind it.
   * We know which layers we created, so we clean them up.
   */
  removeSource(sourceId: string): void {
    const map = this.#map
    if (!map) return // Nothing was ever added; teardown before mount is a no-op, not an error.

    for (const [layerId, entry] of [...this.#layers]) {
      if (entry.sourceId === sourceId) this.removeLayer(layerId)
    }
    if (map.getSource(sourceId)) map.removeSource(sourceId)
    this.#sources.delete(sourceId)
    this.#sourceData.delete(sourceId)
  }

  /* --------------------------------------------------------------- layers */

  addLayer(layerId: string, sourceId: string, style: LayerStyle, beforeId?: string): Disposable {
    const map = this.#requireMap('addLayer')
    if (this.#layers.has(layerId)) {
      throw new Error(
        `[blaeu] addLayer("${layerId}") — a layer with that id already exists. ` +
          `Call setLayerStyle("${layerId}", style) to restyle it, or removeLayer() first.`,
      )
    }
    if (!map.getSource(sourceId)) {
      throw new Error(
        `[blaeu] addLayer("${layerId}") references source "${sourceId}", which does not exist. ` +
          `Call addSource("${sourceId}") first.`,
      )
    }

    const entry: LayerEntry = {
      sourceId,
      beforeId,
      style,
      visible: true,
      native: generateLayers(layerId, sourceId, style),
    }
    if (entry.native.length === 0) {
      throw new Error(
        `[blaeu] addLayer("${layerId}") was given a style with none of fill/line/circle/symbol set, ` +
          `so there is nothing to draw. Set at least one, or use \`native\` with a custom layer type.`,
      )
    }

    const before = this.#resolveBeforeId(beforeId)
    // Each sublayer is inserted immediately *before* the same anchor, so they stack
    // in SUBLAYERS order: fill, then its outline on top of it, then labels on top of
    // that. Insert them in any other order and a polygon eats its own boundary.
    for (const native of entry.native) map.addLayer(toSpec(native, sourceId), before)

    this.#layers.set(layerId, entry)
    return { dispose: () => this.removeLayer(layerId) }
  }

  removeLayer(layerId: string): void {
    const entry = this.#layers.get(layerId)
    if (!entry) return
    this.#layers.delete(layerId)

    const map = this.#map
    if (!map) return
    for (const native of entry.native) {
      if (map.getLayer(native.id)) map.removeLayer(native.id)
    }
  }

  /**
   * Restyle in place where possible.
   *
   * The lazy implementation — remove the layers, add them back — is wrong in a way
   * that only shows up once the map has more than one layer: re-adding puts the
   * layer back at the *top* of the stack, so recolouring your parcels on hover
   * quietly lifts them over the labels. So we diff, and only tear down the sublayers
   * whose shape actually changed (a style that dropped its outline, or one whose
   * `native.filter` moved).
   */
  setLayerStyle(layerId: string, style: LayerStyle): void {
    const map = this.#requireMap('setLayerStyle')
    const entry = this.#layers.get(layerId)
    if (!entry) {
      throw new Error(
        `[blaeu] setLayerStyle("${layerId}") — no such layer. Add it with addLayer() first.`,
      )
    }

    const next = generateLayers(layerId, entry.sourceId, style)
    const previous = new Map(entry.native.map((n) => [n.id, n]))
    const nextIds = new Set(next.map((n) => n.id))
    const before = this.#resolveBeforeId(entry.beforeId)

    for (const old of entry.native) {
      if (!nextIds.has(old.id) && map.getLayer(old.id)) map.removeLayer(old.id)
    }

    for (const native of next) {
      const old = previous.get(native.id)
      const rebuild = !old || !sameJson(old.extra, native.extra) || !map.getLayer(native.id)
      if (rebuild) {
        if (map.getLayer(native.id)) map.removeLayer(native.id)
        map.addLayer(toSpec(native, entry.sourceId), before)
        continue
      }
      // `undefined` is MapLibre's documented "reset to the spec default", which is
      // exactly what a key that disappeared from the style should do.
      for (const key of unionKeys(old.paint, native.paint)) {
        map.setPaintProperty(native.id, key, native.paint[key])
      }
      for (const key of unionKeys(old.layout, native.layout)) {
        if (key === 'visibility') continue // owned by setLayerVisible; see below
        map.setLayoutProperty(native.id, key, native.layout[key])
      }
    }

    entry.native = next
    entry.style = style
    // A restyle must not un-hide a layer the user hid. `visibility` is therefore
    // ours alone, and is re-asserted after every rebuild.
    this.#applyVisibility(map, entry)
  }

  setLayerVisible(layerId: string, visible: boolean): void {
    const map = this.#requireMap('setLayerVisible')
    const entry = this.#layers.get(layerId)
    if (!entry) {
      throw new Error(
        `[blaeu] setLayerVisible("${layerId}") — no such layer. Add it with addLayer() first.`,
      )
    }
    entry.visible = visible
    this.#applyVisibility(map, entry)
  }

  #applyVisibility(map: MapLibreMap, entry: LayerEntry): void {
    const value = entry.visible ? 'visible' : 'none'
    for (const native of entry.native) {
      if (map.getLayer(native.id)) map.setLayoutProperty(native.id, 'visibility', value)
    }
  }

  /* --------------------------------------------------------------- basemap */

  /**
   * Swap the basemap style at runtime — the mechanism behind a theme change.
   *
   * The subtlety that makes this method exist: **`map.setStyle()` deletes every
   * source and every layer.** MapLibre replaces the entire style, and it has no idea
   * that this library added the parcel source and the edit-handle layers on top — it
   * throws them away with the old basemap. A naive `setStyle` therefore wipes the map
   * clean, and the very next `setData` throws *"no such source"*.
   *
   * So after the new style loads we re-materialise everything we own, from our own
   * bookkeeping: each source with the data we last pushed to it, then each layer in
   * its original stacking order. The camera does not move — `setStyle` preserves it —
   * so to the user the ground colour changes and nothing else does.
   */
  async setBasemap(style: string | Record<string, unknown>): Promise<void> {
    const map = this.#requireMap('setBasemap')
    // `diff: false` forces a full replacement. Diffing against a completely different
    // basemap (raster → flat colour, say) is slower and occasionally wrong; a theme
    // swap is not the incremental edit that diffing is built for.
    map.setStyle(style as StyleSpecification, { diff: false })
    await whenStyleReady(map)
    if (this.#destroyed || this.#map !== map) return
    this.#rematerialise(map)
    // setStyle can reset the canvas cursor; re-assert ours.
    if (this.#cursor !== '') map.getCanvas().style.cursor = this.#cursor
  }

  /** Re-add our sources and layers onto a freshly-loaded style, in original order. */
  #rematerialise(map: MapLibreMap): void {
    for (const [sourceId, features] of this.#sourceData) {
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: 'geojson',
          data: toFeatureCollection(features),
          promoteId: ID_PROPERTY,
        })
      }
    }

    // #layers is insertion-ordered, which is the order they were originally stacked;
    // re-adding in the same order reproduces it. A beforeId that pointed at a basemap
    // layer the new style does not have resolves to "on top" rather than throwing.
    for (const [, entry] of this.#layers) {
      const before = this.#resolveBeforeId(entry.beforeId)
      for (const native of entry.native) {
        if (map.getLayer(native.id)) continue
        try {
          map.addLayer(toSpec(native, entry.sourceId), before)
        } catch (err) {
          // A symbol layer needs glyphs; a flat theme basemap ships none. Rather than
          // let one label layer abort the whole swap and leave a half-restored map,
          // skip it and report — the vector features still come back.
          console.error(
            `[blaeu] could not re-add layer "${native.id}" after a basemap change ` +
              `(a symbol layer needs a basemap with a \`glyphs\` endpoint):`,
            err,
          )
        }
      }
      this.#applyVisibility(map, entry)
    }
  }

  /**
   * The MapLibre layer ids one BlaeuMap layer expanded into.
   *
   * Public because the moment somebody reaches for `getNative()` they need these,
   * and guessing them is how a plugin ends up hard-coding a suffix we later change.
   */
  nativeLayerIds(layerId: string): readonly string[] {
    return this.#layers.get(layerId)?.native.map((n) => n.id) ?? []
  }

  /**
   * Translate an anchor into a MapLibre layer id.
   *
   * Accepts either a BlaeuMap layer id or a raw MapLibre one — "put my parcels under
   * the basemap's labels" is a completely reasonable thing to want, and the label
   * layer belongs to the style, not to us.
   *
   * An unknown anchor resolves to `undefined` (i.e. "on top") rather than throwing:
   * MapLibre *does* throw, and a basemap style swapping a layer name in a minor
   * release should not take an application down.
   */
  #resolveBeforeId(beforeId: string | undefined): string | undefined {
    if (beforeId === undefined) return undefined
    const own = this.#layers.get(beforeId)?.native[0]?.id
    if (own !== undefined) return own
    return this.#map?.getLayer(beforeId) ? beforeId : undefined
  }

  /* --------------------------------------------------------------- camera */

  getCamera(): Camera {
    const map = this.#requireMap('getCamera')
    const center = map.getCenter()
    return {
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    }
  }

  setCamera(options: CameraOptions): void {
    const map = this.#requireMap('setCamera')
    const duration = options.duration ?? 0

    const target: EaseToOptions & JumpToOptions = {}
    if (options.center !== undefined) target.center = [options.center[0], options.center[1]]
    if (options.zoom !== undefined) target.zoom = options.zoom
    if (options.bearing !== undefined) target.bearing = options.bearing
    if (options.pitch !== undefined) target.pitch = options.pitch
    if (options.padding !== undefined) target.padding = toPadding(options.padding)

    if (duration > 0) map.easeTo({ ...target, duration })
    else map.jumpTo(target)
  }

  fitBounds(bbox: Bbox, options: { padding?: number; duration?: number } = {}): void {
    const map = this.#requireMap('fitBounds')
    const fit: FitBoundsOptions = { duration: options.duration ?? 0 }
    if (options.padding !== undefined) fit.padding = options.padding
    map.fitBounds([bbox[0], bbox[1], bbox[2], bbox[3]], fit)
  }

  /* ---------------------------------------------------------- hit testing */

  /**
   * Wire the renderer to the store.
   *
   * This exists because **a rendered feature is not a `BlaeuFeature`, and cannot be
   * turned back into one.** MapLibre hands back a `MapGeoJSONFeature`, which is
   * reconstructed from the vector tiles it built internally, and two things were
   * destroyed on the way in:
   *
   * - *Geometry is clipped to the tile.* A parcel spanning a tile boundary comes
   *   back as two features, each cut off at the seam. Handing that to a topology
   *   check would "prove" the parcel has a hole in it.
   * - *Properties are flattened.* Nested objects and arrays are stringified, numbers
   *   may be re-typed, and `meta` was never sent at all.
   *
   * So we do not attempt the reconstruction. We take the feature *id* — the one
   * thing tiling preserves — and ask the store for the real feature. `LayerManager`
   * supplies this hook; without it, `queryAt`/`queryInBox` return nothing, because
   * returning a plausible-but-wrong feature is strictly worse than returning none.
   */
  setFeatureResolver(fn: (id: FeatureId) => BlaeuFeature | undefined): void {
    this.#resolveFeature = fn
  }

  queryAt(point: ScreenPoint, layerIds?: readonly string[]): readonly BlaeuFeature[] {
    const map = this.#requireMap('queryAt')
    const layers = this.#toNativeLayers(layerIds)
    if (layers?.length === 0) return []
    const at: [number, number] = [point.x, point.y]
    return this.#lookup(map.queryRenderedFeatures(at, layers ? { layers } : undefined))
  }

  queryInBox(
    a: ScreenPoint,
    b: ScreenPoint,
    layerIds?: readonly string[],
  ): readonly BlaeuFeature[] {
    const map = this.#requireMap('queryInBox')
    const layers = this.#toNativeLayers(layerIds)
    if (layers?.length === 0) return []
    // MapLibre wants the box corner-ordered. A lasso dragged up-and-left is a
    // perfectly ordinary gesture and would otherwise silently select nothing.
    const min: [number, number] = [Math.min(a.x, b.x), Math.min(a.y, b.y)]
    const max: [number, number] = [Math.max(a.x, b.x), Math.max(a.y, b.y)]
    return this.#lookup(map.queryRenderedFeatures([min, max], layers ? { layers } : undefined))
  }

  /** `undefined` means "every layer"; an empty array means "no layer matched". */
  #toNativeLayers(layerIds: readonly string[] | undefined): string[] | undefined {
    if (layerIds === undefined) return undefined
    const out: string[] = []
    for (const layerId of layerIds) {
      const entry = this.#layers.get(layerId)
      if (entry) out.push(...entry.native.map((n) => n.id))
      // A raw MapLibre layer id is legitimate here too — hit-testing the basemap.
      else if (this.#map?.getLayer(layerId)) out.push(layerId)
    }
    return out
  }

  #lookup(hits: readonly MapGeoJSONFeature[]): readonly BlaeuFeature[] {
    const resolve = this.#resolveFeature
    if (!resolve) {
      if (!this.#warnedMissingResolver) {
        this.#warnedMissingResolver = true
        console.warn(
          '[blaeu] MapLibreRenderer has no feature resolver, so hit-testing returns nothing. ' +
            'Call renderer.setFeatureResolver(id => store.get(id)) — LayerManager normally does this for you.',
        )
      }
      return []
    }

    // A feature crossing a tile boundary comes back once per tile. Deduplicate by
    // id, or a two-tile parcel gets selected twice and a counter reads "2 parcels".
    const seen = new Set<FeatureId>()
    const out: BlaeuFeature[] = []
    for (const hit of hits) {
      const id = featureIdOf(hit)
      if (id === undefined || seen.has(id)) continue
      seen.add(id)
      const feature = resolve(id)
      if (feature) out.push(feature)
    }
    return out
  }

  /* --------------------------------------------------------------- events */

  onPointer(handler: (event: RendererPointerEvent) => void): Disposable {
    this.#pointerHandlers.add(handler)
    return { dispose: () => this.#pointerHandlers.delete(handler) }
  }

  onCamera(handler: (camera: Camera, moving: boolean) => void): Disposable {
    this.#cameraHandlers.add(handler)
    return { dispose: () => this.#cameraHandlers.delete(handler) }
  }

  #bind(map: MapLibreMap): void {
    this.#subscriptions = [
      map.on('mousedown', (e) => this.#dispatchPointer('pointerdown', e)),
      map.on('mousemove', (e) => this.#dispatchPointer('pointermove', e)),
      map.on('mouseup', (e) => this.#dispatchPointer('pointerup', e)),
      map.on('click', (e) => this.#dispatchPointer('click', e)),
      map.on('dblclick', (e) => this.#dispatchPointer('dblclick', e)),

      map.on('touchstart', (e) => this.#onTouch('pointerdown', e)),
      map.on('touchmove', (e) => this.#onTouch('pointermove', e)),
      map.on('touchend', (e) => this.#onTouch('pointerup', e)),
      // A cancelled touch (a notification slides in, the browser takes the gesture)
      // must still end the gesture, or a draw tool stays stuck mid-drag forever.
      map.on('touchcancel', (e) => this.#onTouch('pointerup', e)),

      map.on('move', () => this.#dispatchCamera(true)),
      map.on('moveend', () => this.#dispatchCamera(false)),
    ]
  }

  /**
   * Normalise touch into the same pointer stream as the mouse.
   *
   * Two decisions here, both learned the hard way:
   *
   * **Multi-touch is not a pointer gesture.** MapLibre reports a pinch as a
   * `touchmove` at the *centroid* of the two fingers. Forwarding that would let a
   * draw tool drop a vertex halfway between someone's thumb and forefinger while
   * they were only trying to zoom — the bug that makes touch drawing feel haunted.
   *
   * **`dblclick` has to be synthesised.** Browsers do not fire `dblclick` from taps;
   * it is a mouse event. But double-tap is exactly how you close a polygon on a
   * phone, and every tool in the library listens for `dblclick`. We do *not*
   * synthesise `click` — the browser already emits one after a tap and MapLibre
   * re-fires it, so fabricating our own would double every tap.
   */
  #onTouch(kind: 'pointerdown' | 'pointermove' | 'pointerup', event: MapTouchEvent): void {
    if (event.points.length > 1) {
      this.#lastTap = undefined
      return
    }
    // `touchcancel` can arrive with no touches at all, in which case MapLibre's
    // centroid maths produces NaN — and a NaN coordinate renders as "nothing there"
    // rather than as an error, which is the worst way to fail.
    if (!Number.isFinite(event.point.x) || !Number.isFinite(event.point.y)) return

    this.#dispatchPointer(kind, event)
    if (kind !== 'pointerup') return

    const now = Date.now()
    const last = this.#lastTap
    const doubled =
      last !== undefined &&
      now - last.at <= DOUBLE_TAP_MS &&
      Math.hypot(event.point.x - last.x, event.point.y - last.y) <= DOUBLE_TAP_PX

    if (doubled) {
      this.#lastTap = undefined
      this.#dispatchPointer('dblclick', event)
    } else {
      this.#lastTap = { at: now, x: event.point.x, y: event.point.y }
    }
  }

  #dispatchPointer(kind: RendererPointerEvent['kind'], event: MapMouseEvent | MapTouchEvent): void {
    if (this.#destroyed) return

    const original = event.originalEvent
    const normalised: RendererPointerEvent = {
      kind,
      lngLat: [event.lngLat.lng, event.lngLat.lat],
      screen: { x: event.point.x, y: event.point.y },
      button: 'button' in original ? original.button : 0,
      modifiers: {
        shift: original.shiftKey,
        ctrl: original.ctrlKey,
        alt: original.altKey,
        meta: original.metaKey,
      },
      originalEvent: original,
    }

    // Snapshot: a tool that deactivates itself on `dblclick` disposes its own
    // subscription mid-dispatch, and mutating the set under iteration would skip
    // whichever handler happened to be next.
    for (const handler of [...this.#pointerHandlers]) {
      try {
        handler(normalised)
      } catch (err) {
        // One broken tool must not wedge the pointer stream for every other
        // listener — and must not leave MapLibre's own handlers half-run.
        console.error(`[blaeu] pointer handler threw on "${kind}":`, err)
      }
    }
  }

  #dispatchCamera(moving: boolean): void {
    if (this.#destroyed || !this.#map) return
    const camera = this.getCamera()
    for (const handler of [...this.#cameraHandlers]) {
      try {
        handler(camera, moving)
      } catch (err) {
        console.error('[blaeu] camera handler threw:', err)
      }
    }
  }

  /* ---------------------------------------------------------------- misc. */

  setCursor(cursor: string): void {
    this.#cursor = cursor
    const canvas = this.#map?.getCanvas()
    if (canvas) canvas.style.cursor = cursor
  }

  getNative<T = unknown>(): T {
    return this.#requireMap('getNative') as unknown as T
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true

    for (const subscription of this.#subscriptions) subscription.unsubscribe()
    this.#subscriptions = []
    this.#pointerHandlers.clear()
    this.#cameraHandlers.clear()
    this.#layers.clear()
    this.#sources.clear()
    this.#sourceData.clear()
    this.#resolveFeature = undefined
    this.#lastTap = undefined

    // Tears down the WebGL context, the workers, and every DOM listener MapLibre
    // attached. Skipping it leaks a GPU context per map, and browsers cap those at
    // around sixteen — a SPA that mounts and unmounts a map goes white on the
    // seventeenth route change.
    this.#map?.remove()
    this.#map = undefined
  }

  #requireMap(operation: string): MapLibreMap {
    if (this.#destroyed) {
      throw new Error(`[blaeu] MapLibreRenderer.${operation}() called after destroy().`)
    }
    const map = this.#map
    if (!map) {
      throw new Error(
        `[blaeu] MapLibreRenderer.${operation}() called before the map was mounted. ` +
          `Await createBlaeuMap(...) — or map.whenReady() — before touching the renderer.`,
      )
    }
    return map
  }
}

/* ========================================================================= */
/* Module loading                                                            */
/* ========================================================================= */

/** Exactly the surface of `maplibre-gl` this file uses. Nothing else is our business. */
interface MapLibreModule {
  readonly Map: new (options: MapOptions) => MapLibreMap
}

let modulePromise: Promise<MapLibreModule> | undefined

/**
 * Load MapLibre lazily, at mount.
 *
 * A static `import 'maplibre-gl'` would put ~800 kB of WebGL into the module graph
 * of every consumer of `@blaeu/core` — including the ones that pass their own
 * renderer, and including the entire test suite, which runs headless against the
 * `FakeRenderer` and has no business paying for a graphics library. Deferring it to
 * `mount()` costs nothing (mount is already async) and means the seam in `Renderer`
 * is real at the *bundle* level, not just the type level.
 *
 * The interop dance is not paranoia. `maplibre-gl` ships a UMD bundle with no
 * `exports` map and no ESM entry, so Node's CJS interop hands the namespace back
 * under `default` while a bundler hands it back directly. Betting on either one
 * breaks the other.
 */
async function loadMapLibre(): Promise<MapLibreModule> {
  modulePromise ??= import('maplibre-gl').then((mod) => {
    const namespace = mod as unknown as MapLibreModule & { default?: MapLibreModule }
    const ns = namespace.default ?? namespace
    if (typeof ns.Map !== 'function') {
      throw new Error(
        '[blaeu] maplibre-gl resolved without a `Map` export. It is a peer dependency — ' +
          'check that a compatible version (>=4.7 <6) is installed and that your bundler is not aliasing it.',
      )
    }
    return ns
  })
  return modulePromise
}

/**
 * Resolve when the map is usable; reject rather than hang when it never will be.
 *
 * The failure mode this guards against: a style URL that 404s means `load` never
 * fires, `mount()` never settles, `createBlaeuMap()` never resolves, and the
 * application shows a spinner forever with nothing in the console pointing at the
 * cause. A rejected promise carrying MapLibre's own error is strictly better.
 *
 * But *source* errors are excluded, because they are recoverable and routine: a
 * missing tile is a blank square, not a dead map, and one 404 on a slow network
 * must not take the whole map down with it. MapLibre tags those with a `sourceId`,
 * which is the discriminator we use.
 */
function whenLoaded(map: MapLibreMap): Promise<void> {
  if (map.loaded()) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const subscriptions: Subscription[] = []
    const cleanup = (): void => {
      for (const subscription of subscriptions) subscription.unsubscribe()
    }

    subscriptions.push(
      map.on('load', () => {
        cleanup()
        resolve()
      }),
      map.on('error', (event: { error?: { message?: string }; sourceId?: string }) => {
        if (event.sourceId !== undefined) return
        cleanup()
        reject(
          new Error(
            `[blaeu] MapLibre failed to load its style: ${event.error?.message ?? 'unknown error'}. ` +
              `Check the \`style\` passed to MapLibreRenderer — it must be reachable from the browser.`,
          ),
        )
      }),
      map.on('remove', () => {
        cleanup()
        reject(new Error('[blaeu] the renderer was destroyed before the map finished loading.'))
      }),
    )
  })
}

/**
 * Resolve once a freshly-set style has finished loading.
 *
 * `setStyle()` is asynchronous: it returns immediately and the new style becomes
 * usable a tick or several later, signalled by `styledata`. We poll `isStyleLoaded()`
 * on each `styledata` because a single event can fire before the style is fully
 * parsed (sprites, the diff), and re-adding a source into a not-yet-ready style is
 * the kind of race that fails once in fifty runs and never in a test.
 */
function whenStyleReady(map: MapLibreMap): Promise<void> {
  if (map.isStyleLoaded()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const onData = (): void => {
      if (!map.isStyleLoaded()) return
      map.off('styledata', onData)
      resolve()
    }
    map.on('styledata', onData)
  })
}

/* ========================================================================= */
/* Style translation                                                         */
/* ========================================================================= */

/**
 * `LayerStyle` → MapLibre layers.
 *
 * Sublayer ids are *always* suffixed (`parcels::fill`), never bare — even when a
 * style produces exactly one of them. It is tempting to give the single common case
 * the plain `parcels` id, and it is a trap: adding an outline to that style would
 * then silently *rename* the fill layer, breaking every `beforeId` and every
 * `getNative()` call that referenced it. An id that depends on the style is not an
 * id. `nativeLayerIds()` is the supported way to discover them.
 */
function generateLayers(layerId: string, sourceId: string, style: LayerStyle): NativeLayer[] {
  const out: NativeLayer[] = []

  for (const type of SUBLAYERS) {
    const paint: Record<string, unknown> = {}
    const layout: Record<string, unknown> = {}

    switch (type) {
      case 'fill': {
        const fill = style.fill
        if (!fill) continue
        set(paint, 'fill-color', fill.color)
        set(paint, 'fill-opacity', fill.opacity)
        set(paint, 'fill-outline-color', fill.outlineColor)
        break
      }
      case 'line': {
        const line = style.line
        if (!line) continue
        set(paint, 'line-color', line.color)
        set(paint, 'line-width', line.width)
        set(paint, 'line-opacity', line.opacity)
        // MapLibre mutates the arrays it is handed; a readonly tuple from a preset
        // that is reused across maps must not be one of them.
        if (line.dasharray) set(paint, 'line-dasharray', [...line.dasharray])
        break
      }
      case 'circle': {
        const circle = style.circle
        if (!circle) continue
        set(paint, 'circle-color', circle.color)
        set(paint, 'circle-radius', circle.radius)
        set(paint, 'circle-stroke-color', circle.strokeColor)
        set(paint, 'circle-stroke-width', circle.strokeWidth)
        break
      }
      case 'symbol': {
        const symbol = style.symbol
        if (!symbol) continue
        set(layout, 'icon-image', symbol.icon)
        set(layout, 'text-field', symbol.text)
        // `size` means whichever of the two the layer actually draws. Setting
        // `text-size` on an icon-only layer is harmless but noise; setting neither
        // when both are present is a bug.
        if (symbol.icon !== undefined) set(layout, 'icon-size', symbol.size)
        if (symbol.text !== undefined) set(layout, 'text-size', symbol.size)
        break
      }
    }

    const extra: Record<string, unknown> = {}
    applyNative(style.native, type, paint, layout, extra)
    out.push({ id: `${layerId}::${type}`, type, paint, layout, extra })
  }

  return out
}

/**
 * Merge `style.native` last, routed to the sublayer it actually belongs to.
 *
 * The routing is the non-obvious part. A polygon style expands into a `fill` layer
 * *and* a `line` layer; blindly copying `paint: { 'fill-color': ... }` onto both
 * would hand MapLibre a line layer with a fill property, and MapLibre throws on
 * that. So a key is matched to its sublayer by prefix, and keys that belong to no
 * sublayer in particular (`visibility`, and layer-level things like `filter` and
 * `minzoom`) go to all of them.
 *
 * `native` deliberately cannot change a layer's `type` or `source`. Wanting to is a
 * signal that you want a *new layer type* — that is what `LayerTypeDef` is for, and
 * it composes; a fill layer secretly pretending to be a fill-extrusion does not.
 */
function applyNative(
  native: Record<string, unknown> | undefined,
  type: NativeLayerType,
  paint: Record<string, unknown>,
  layout: Record<string, unknown>,
  extra: Record<string, unknown>,
): void {
  if (!native) return

  for (const [key, value] of Object.entries(native)) {
    if (key === 'paint' || key === 'layout') {
      const target = key === 'paint' ? paint : layout
      for (const [name, propertyValue] of Object.entries(asRecord(value))) {
        if (ownerOf(name) !== undefined && ownerOf(name) !== type) continue
        target[name] = propertyValue
      }
      continue
    }
    if (STRUCTURAL_KEYS.has(key)) continue
    extra[key] = value
  }
}

function ownerOf(key: string): NativeLayerType | undefined {
  return SUBLAYERS.find((type) => KEY_PREFIXES[type].some((prefix) => key.startsWith(prefix)))
}

function toSpec(native: NativeLayer, sourceId: string): LayerSpecification {
  // MapLibre's style-spec types express every paint key as a discriminated union of
  // expression shapes. Reconstructing that from our renderer-agnostic `LayerStyle`
  // would mean re-implementing their validator in our type system; MapLibre already
  // validates at `addLayer` and reports better errors than we would. One cast, at
  // the boundary, is the honest trade.
  return {
    ...native.extra,
    id: native.id,
    type: native.type,
    source: sourceId,
    paint: native.paint,
    layout: native.layout,
  } as unknown as LayerSpecification
}

/** Skips `undefined` so an absent key stays absent rather than becoming `null`. */
function set(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value
}

function unionKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
}

function sameJson(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/* ========================================================================= */
/* Feature translation                                                       */
/* ========================================================================= */

/**
 * `BlaeuFeature[]` → a GeoJSON `FeatureCollection` MapLibre will accept.
 *
 * Hidden features are dropped here rather than filtered in the style, because
 * `meta.hidden` means "stays in the store, is not sent to the renderer"
 * (`feature.ts`) — and a feature that is not sent cannot be hit-tested, which is the
 * behaviour a hidden feature should have.
 *
 * `$hidden` is nevertheless written out, always `false` in practice. That is not an
 * oversight: a style expression referencing `['get', '$hidden']` must not evaluate
 * against a missing key, and the day someone builds a "ghost" layer type that *does*
 * render hidden features greyed out, the property is already there and the styles
 * that read it already work.
 */
function toFeatureCollection(features: readonly BlaeuFeature[]): FeatureCollection {
  const out: Feature[] = []

  for (const feature of features) {
    if (feature.meta.hidden === true) continue
    out.push({
      type: 'Feature',
      // Set for the benefit of anything reading the raw GeoJSON back out. MapLibre
      // itself ignores it in favour of `promoteId` — see `addSource` for why.
      id: feature.id,
      geometry: feature.geometry,
      properties: {
        ...feature.properties,
        [ID_PROPERTY]: feature.id,
        [LOCKED_PROPERTY]: feature.meta.locked === true,
        // Always false by construction — the hidden ones never get this far.
        [HIDDEN_PROPERTY]: false,
      },
    })
  }

  return { type: 'FeatureCollection', features: out }
}

function featureIdOf(hit: MapGeoJSONFeature): FeatureId | undefined {
  if (typeof hit.id === 'string') return hit.id
  if (typeof hit.id === 'number') return String(hit.id)
  const promoted: unknown = hit.properties[ID_PROPERTY]
  return typeof promoted === 'string' ? promoted : undefined
}

/* ========================================================================= */
/* Small adapters                                                            */
/* ========================================================================= */

function applyInteraction(map: MapLibreMap, interaction: Partial<InteractionConfig>): void {
  toggle(map.doubleClickZoom, interaction.doubleClickZoom)
  toggle(map.dragPan, interaction.dragPan)
  toggle(map.scrollZoom, interaction.scrollZoom)
  toggle(map.keyboard, interaction.keyboard)
}

function toggle(handler: { enable(): void; disable(): void }, enabled: boolean | undefined): void {
  if (enabled === undefined) return
  if (enabled) handler.enable()
  else handler.disable()
}

function toPadding(padding: NonNullable<CameraOptions['padding']>): PaddingOptions {
  return typeof padding === 'number'
    ? { top: padding, bottom: padding, left: padding, right: padding }
    : { ...padding }
}
