// `FeatureId` lives in common.js — feature.ts imports it but does not re-export it.
import type { Bbox, Disposable, FeatureId, LngLat, ScreenPoint } from '../types/common.js'
import type { BlaeuFeature, Geometry, Position } from '../types/feature.js'
import type {
  Camera,
  CameraOptions,
  LayerStyle,
  Renderer,
  RendererPointerEvent,
} from '../types/renderer.js'
import type { InteractionConfig } from '../types/config.js'

/** MapLibre's tile size. Using the same one keeps zoom levels comparable with a real map. */
const TILE_SIZE = 512

/** The latitude where Web Mercator's y goes to infinity. Beyond this there is nothing to draw. */
const MAX_MERCATOR_LAT = 85.051128779806589

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

/** What a layer was created with, recorded so tests can assert on it. */
export interface FakeLayerRecord {
  readonly id: string
  readonly sourceId: string
  style: LayerStyle
  readonly beforeId: string | undefined
  visible: boolean
}

/**
 * Resolves a feature id back to the live `BlaeuFeature`.
 *
 * `LayerManager` wires this (`renderer.setFeatureResolver(id => store.find(id))`)
 * because a real renderer only holds a *rendered* copy of the data — MapLibre hands
 * back a plain GeoJSON feature with an id and no `meta`, and hit-testing must return
 * the store's object, not that. The fake renderer honours the same contract, so a
 * test hit-tests against the store's current geometry rather than against whatever
 * the last `setData` happened to snapshot.
 */
export type FeatureResolver = (id: FeatureId) => BlaeuFeature | undefined

export interface FakeRendererOptions {
  readonly width?: number
  readonly height?: number
  readonly camera?: Partial<Camera>
  /** How close, in pixels, the pointer must be to a line or point to hit it. */
  readonly hitTolerancePx?: number
}

/** Everything `emitPointer` needs; the rest is filled in with browser-like defaults. */
export interface FakePointerEventInit {
  readonly kind: RendererPointerEvent['kind']
  /** Give either a geographic or a screen position — the other is derived. */
  readonly lngLat?: LngLat
  readonly screen?: ScreenPoint
  readonly button?: number
  readonly modifiers?: Partial<RendererPointerEvent['modifiers']>
}

/**
 * A complete {@link Renderer} with no GPU, no DOM, and no MapLibre.
 *
 * This class is the proof that the renderer seam is real rather than aspirational:
 * the entire kernel, every plugin and every preset test runs against it, headless,
 * in milliseconds. If something can only be tested with WebGL, the abstraction has
 * leaked and that is a bug in the core, not a reason to spin up a browser.
 *
 * ## Why the projection is done properly
 *
 * `project`/`unproject` implement real spherical Web Mercator, parameterised by a
 * fake camera. It would have been far less code to scale longitude and latitude
 * linearly — and it would have made every pixel-denominated test a lie. Snapping
 * tolerances are in **screen pixels**; under a linear fake, "8 px from that vertex"
 * would mean a different ground distance at 39°N than at 60°N, so a snap test that
 * passed in Ankara would fail in Oslo for reasons that have nothing to do with the
 * snap engine. With the real projection, a test can say *the pointer is 8 pixels
 * from that vertex* and mean it.
 *
 * Pitch is ignored (this renderer is orthographic); bearing is honoured, because a
 * rotated map is a genuinely different hit-test and tools must survive one.
 */
export class FakeRenderer implements Renderer {
  readonly kind = 'fake'

  /* --- inspectable state: tests assert on these directly --- */
  readonly sources = new Map<string, BlaeuFeature[]>()
  readonly layers = new Map<string, FakeLayerRecord>()

  /* --- call counters: "did the LayerManager coalesce 500 changes into 1 setData?" --- */
  setDataCalls = 0
  /** Per source, for when one chatty source must not hide behind a quiet one. */
  readonly setDataCallsBySource = new Map<string, number>()
  addSourceCalls = 0
  removeSourceCalls = 0
  addLayerCalls = 0
  removeLayerCalls = 0
  setLayerStyleCalls = 0
  setLayerVisibleCalls = 0
  setCameraCalls = 0
  fitBoundsCalls = 0
  setBasemapCalls = 0

  cursor = 'default'
  /** The last basemap handed to {@link setBasemap}, for a test asserting a theme swap reached the renderer. */
  basemap: string | Record<string, unknown> | undefined
  /** The last config handed to {@link setInteraction}, for a test asserting the kernel wired it through. */
  interaction: Partial<InteractionConfig> | undefined
  mounted = false
  destroyed = false
  container: HTMLElement | undefined

  readonly width: number
  readonly height: number
  readonly hitTolerancePx: number

  #camera: Camera
  #resolve: FeatureResolver | undefined
  #pointerHandlers: ((event: RendererPointerEvent) => void)[] = []
  #cameraHandlers: ((camera: Camera, moving: boolean) => void)[] = []

  constructor(options: FakeRendererOptions = {}) {
    this.width = options.width ?? 800
    this.height = options.height ?? 600
    this.hitTolerancePx = options.hitTolerancePx ?? 5
    this.#camera = {
      center: options.camera?.center ?? [0, 0],
      zoom: options.camera?.zoom ?? 0,
      bearing: options.camera?.bearing ?? 0,
      pitch: options.camera?.pitch ?? 0,
    }
  }

  mount(container: HTMLElement): Promise<void> {
    this.container = container
    this.mounted = true
    return Promise.resolve()
  }

  /* ===================================================================== */
  /* Coordinate transforms — exact inverses of each other                  */
  /* ===================================================================== */

  project(lngLat: LngLat): ScreenPoint {
    const [lng, lat] = lngLat
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new Error(
        `[blaeu] FakeRenderer.project() got a non-finite coordinate [${lng}, ${lat}]. ` +
          `A NaN coordinate renders as "nothing there" rather than as an error — which is why this throws instead.`,
      )
    }

    const scale = TILE_SIZE * 2 ** this.#camera.zoom
    const centre = mercator(this.#camera.center)
    const point = mercator([lng, lat])

    const dx = (point[0] - centre[0]) * scale
    const dy = (point[1] - centre[1]) * scale
    const [rx, ry] = rotate(dx, dy, -this.#camera.bearing * DEG2RAD)

    return { x: rx + this.width / 2, y: ry + this.height / 2 }
  }

  unproject(point: ScreenPoint): LngLat {
    const scale = TILE_SIZE * 2 ** this.#camera.zoom
    const centre = mercator(this.#camera.center)

    const [dx, dy] = rotate(
      point.x - this.width / 2,
      point.y - this.height / 2,
      this.#camera.bearing * DEG2RAD,
    )

    return unmercator([centre[0] + dx / scale, centre[1] + dy / scale])
  }

  /* ===================================================================== */
  /* Data                                                                  */
  /* ===================================================================== */

  setData(sourceId: string, features: readonly BlaeuFeature[]): void {
    this.setDataCalls++
    this.setDataCallsBySource.set(sourceId, (this.setDataCallsBySource.get(sourceId) ?? 0) + 1)
    this.sources.set(sourceId, [...features])
  }

  addSource(sourceId: string, features: readonly BlaeuFeature[] = []): Disposable {
    this.addSourceCalls++
    this.sources.set(sourceId, [...features])
    return { dispose: () => this.removeSource(sourceId) }
  }

  removeSource(sourceId: string): void {
    this.removeSourceCalls++
    this.sources.delete(sourceId)
    this.setDataCallsBySource.delete(sourceId)
  }

  /**
   * Hit-testing reads through this when the `LayerManager` has wired it, so a query
   * returns the store's live feature rather than the copy `setData` last snapshotted.
   */
  setFeatureResolver(resolve: FeatureResolver): void {
    this.#resolve = resolve
  }

  /* ===================================================================== */
  /* Layers                                                                */
  /* ===================================================================== */

  addLayer(layerId: string, sourceId: string, style: LayerStyle, beforeId?: string): Disposable {
    this.addLayerCalls++
    this.layers.set(layerId, { id: layerId, sourceId, style, beforeId, visible: true })
    return { dispose: () => this.removeLayer(layerId) }
  }

  removeLayer(layerId: string): void {
    this.removeLayerCalls++
    this.layers.delete(layerId)
  }

  setLayerStyle(layerId: string, style: LayerStyle): void {
    this.setLayerStyleCalls++
    const layer = this.layers.get(layerId)
    if (layer) layer.style = style
  }

  setLayerVisible(layerId: string, visible: boolean): void {
    this.setLayerVisibleCalls++
    const layer = this.layers.get(layerId)
    if (layer) layer.visible = visible
  }

  /**
   * Model the real renderer's *net* behaviour: the basemap changes and the map
   * survives. The MapLibre implementation tears its sources and layers down on
   * `setStyle()` and re-materialises them; the observable end state — same sources,
   * same layers, new ground — is what this reproduces, so a test that switches theme
   * and then queries a feature behaves as it does in the browser.
   */
  setBasemap(style: string | Record<string, unknown>): Promise<void> {
    this.setBasemapCalls++
    this.basemap = style
    return Promise.resolve()
  }

  setInteraction(interaction: Partial<InteractionConfig>): void {
    this.interaction = interaction
  }

  /* ===================================================================== */
  /* Camera                                                                */
  /* ===================================================================== */

  getCamera(): Camera {
    return this.#camera
  }

  setCamera(options: CameraOptions): void {
    this.setCameraCalls++
    // `duration` and `padding` are honoured by being ignored: a fake renderer that
    // animated would make every test wait for a camera it does not care about.
    this.emitCamera(
      {
        ...(options.center !== undefined ? { center: options.center } : {}),
        ...(options.zoom !== undefined ? { zoom: options.zoom } : {}),
        ...(options.bearing !== undefined ? { bearing: options.bearing } : {}),
        ...(options.pitch !== undefined ? { pitch: options.pitch } : {}),
      },
      false,
    )
  }

  fitBounds(bbox: Bbox, options: { padding?: number; duration?: number } = {}): void {
    this.fitBoundsCalls++
    const [west, south, east, north] = bbox
    const padding = options.padding ?? 0

    const sw = mercator([west, south])
    const ne = mercator([east, north])
    const spanX = Math.abs(ne[0] - sw[0])
    const spanY = Math.abs(ne[1] - sw[1])

    const usableWidth = Math.max(this.width - 2 * padding, 1)
    const usableHeight = Math.max(this.height - 2 * padding, 1)

    // A degenerate bbox (a single point) has zero span, and log2(Infinity) is not a
    // zoom level. Clamp to something a real map would also refuse to exceed.
    const scaleX = spanX > 0 ? usableWidth / (spanX * TILE_SIZE) : Infinity
    const scaleY = spanY > 0 ? usableHeight / (spanY * TILE_SIZE) : Infinity
    const scale = Math.min(scaleX, scaleY)
    const zoom = Number.isFinite(scale) ? Math.min(Math.log2(scale), 24) : 24

    this.emitCamera({ center: unmercator([(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2]), zoom }, false)
  }

  /* ===================================================================== */
  /* Hit testing                                                           */
  /* ===================================================================== */

  queryAt(point: ScreenPoint, layerIds?: readonly string[]): readonly BlaeuFeature[] {
    return this.#query(layerIds, (geometry) => this.#hitsPoint(geometry, point))
  }

  queryInBox(
    a: ScreenPoint,
    b: ScreenPoint,
    layerIds?: readonly string[],
  ): readonly BlaeuFeature[] {
    const box = {
      minX: Math.min(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxX: Math.max(a.x, b.x),
      maxY: Math.max(a.y, b.y),
    }
    const centre: ScreenPoint = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }

    return this.#query(layerIds, (geometry) => {
      // Either the feature pokes into the box, or the box sits entirely inside the
      // feature (a lasso drawn in the middle of a large parcel must still select it).
      if (this.#coordinates(geometry).some((p) => inBox(p, box))) return true
      return this.#hitsPoint(geometry, centre)
    })
  }

  #query(
    layerIds: readonly string[] | undefined,
    test: (geometry: Geometry) => boolean,
  ): readonly BlaeuFeature[] {
    const out: BlaeuFeature[] = []
    const seen = new Set<FeatureId>()

    for (const sourceId of this.#sourcesToQuery(layerIds)) {
      for (const feature of this.#featuresOf(sourceId)) {
        // Hidden features are in the store but not on the map, and you cannot click
        // what you cannot see.
        if (feature.meta.hidden) continue
        if (seen.has(feature.id)) continue
        if (!test(feature.geometry)) continue
        seen.add(feature.id)
        out.push(feature)
      }
    }
    return out
  }

  /** Topmost layer first — later layers draw over earlier ones, so they are hit first. */
  #sourcesToQuery(layerIds: readonly string[] | undefined): readonly string[] {
    const layers = [...this.layers.values()].reverse()
    const wanted = layerIds
      ? layers.filter((l) => layerIds.includes(l.id))
      : layers.filter((l) => l.visible)

    if (wanted.length > 0) {
      return [...new Set(wanted.map((l) => l.sourceId))]
    }
    // No layers at all: a harness test that seeded features but never declared a
    // layer would otherwise hit-test nothing, which surprises far more people than
    // it protects. Once any layer exists, or the caller named one, we respect that
    // strictly — an invisible layer must not be clickable.
    if (layerIds !== undefined || this.layers.size > 0) return []
    return [...this.sources.keys()]
  }

  /**
   * Which features a source holds, each one refreshed through the resolver.
   *
   * The source records say *what is on the map*; the resolver says *what that thing
   * currently is*. Reading both is what stops a test hit-testing a vertex the user
   * has already dragged away.
   */
  #featuresOf(sourceId: string): readonly BlaeuFeature[] {
    const rendered = this.sources.get(sourceId) ?? []
    if (!this.#resolve) return rendered
    return rendered.map((feature) => this.#resolve?.(feature.id) ?? feature)
  }

  /* ===================================================================== */
  /* Events — the harness drives these                                     */
  /* ===================================================================== */

  onPointer(handler: (event: RendererPointerEvent) => void): Disposable {
    this.#pointerHandlers.push(handler)
    return {
      dispose: () => {
        const i = this.#pointerHandlers.indexOf(handler)
        if (i >= 0) this.#pointerHandlers.splice(i, 1)
      },
    }
  }

  onCamera(handler: (camera: Camera, moving: boolean) => void): Disposable {
    this.#cameraHandlers.push(handler)
    return {
      dispose: () => {
        const i = this.#cameraHandlers.indexOf(handler)
        if (i >= 0) this.#cameraHandlers.splice(i, 1)
      },
    }
  }

  /** Synthesise a pointer event. Returns the event it built, for assertions. */
  emitPointer(init: FakePointerEventInit): RendererPointerEvent {
    const lngLat = init.lngLat ?? (init.screen ? this.unproject(init.screen) : undefined)
    if (!lngLat) {
      throw new Error(
        '[blaeu] FakeRenderer.emitPointer() needs either a lngLat or a screen point — it cannot invent a position.',
      )
    }

    const event: RendererPointerEvent = {
      kind: init.kind,
      lngLat,
      screen: init.screen ?? this.project(lngLat),
      button: init.button ?? 0,
      modifiers: {
        shift: init.modifiers?.shift ?? false,
        ctrl: init.modifiers?.ctrl ?? false,
        alt: init.modifiers?.alt ?? false,
        meta: init.modifiers?.meta ?? false,
      },
      originalEvent: syntheticEvent(init.kind),
    }

    for (const handler of [...this.#pointerHandlers]) handler(event)
    return event
  }

  /** Move the fake camera and notify. `moving: true` is a drag; `false` is an idle. */
  emitCamera(camera: Partial<Camera>, moving = false): void {
    this.#camera = {
      center: camera.center ?? this.#camera.center,
      zoom: camera.zoom ?? this.#camera.zoom,
      bearing: camera.bearing ?? this.#camera.bearing,
      pitch: camera.pitch ?? this.#camera.pitch,
    }
    for (const handler of [...this.#cameraHandlers]) handler(this.#camera, moving)
  }

  setCursor(cursor: string): void {
    this.cursor = cursor
  }

  getNative<T = unknown>(): T {
    return this as unknown as T
  }

  /** Zero the counters. Handy after fixture seeding, so a test measures only its own writes. */
  resetCalls(): void {
    this.setDataCalls = 0
    this.setDataCallsBySource.clear()
    this.addSourceCalls = 0
    this.removeSourceCalls = 0
    this.addLayerCalls = 0
    this.removeLayerCalls = 0
    this.setLayerStyleCalls = 0
    this.setLayerVisibleCalls = 0
    this.setCameraCalls = 0
    this.fitBoundsCalls = 0
    this.setBasemapCalls = 0
  }

  destroy(): void {
    this.destroyed = true
    this.mounted = false
    this.#pointerHandlers = []
    this.#cameraHandlers = []
    this.#resolve = undefined
    this.sources.clear()
    this.layers.clear()
  }

  /* ===================================================================== */
  /* Geometry, in screen space                                             */
  /* ===================================================================== */

  #hitsPoint(geometry: Geometry, point: ScreenPoint): boolean {
    switch (geometry.type) {
      case 'Point':
        return distance(this.#screen(geometry.coordinates), point) <= this.hitTolerancePx
      case 'MultiPoint':
        return geometry.coordinates.some(
          (c) => distance(this.#screen(c), point) <= this.hitTolerancePx,
        )
      case 'LineString':
        return this.#nearLine(geometry.coordinates, point)
      case 'MultiLineString':
        return geometry.coordinates.some((line) => this.#nearLine(line, point))
      case 'Polygon':
        return this.#inPolygon(geometry.coordinates, point)
      case 'MultiPolygon':
        return geometry.coordinates.some((polygon) => this.#inPolygon(polygon, point))
      case 'GeometryCollection':
        return geometry.geometries.some((g) => this.#hitsPoint(g, point))
    }
  }

  #nearLine(line: readonly Position[], point: ScreenPoint): boolean {
    const pts = line.map((c) => this.#screen(c))
    for (let i = 0; i + 1 < pts.length; i++) {
      if (distanceToSegment(point, pts[i]!, pts[i + 1]!) <= this.hitTolerancePx) return true
    }
    return false
  }

  #inPolygon(rings: readonly (readonly Position[])[], point: ScreenPoint): boolean {
    const exterior = rings[0]
    if (!exterior) return false

    // Clicking exactly *on* the boundary counts as a hit — a user aiming at a parcel
    // edge to select the parcel is doing the most ordinary thing there is.
    if (rings.some((ring) => this.#nearLine(ring, point))) return true

    if (
      !pointInRing(
        point,
        exterior.map((c) => this.#screen(c)),
      )
    )
      return false
    for (let i = 1; i < rings.length; i++) {
      if (
        pointInRing(
          point,
          rings[i]!.map((c) => this.#screen(c)),
        )
      )
        return false // in a hole
    }
    return true
  }

  #coordinates(geometry: Geometry): ScreenPoint[] {
    switch (geometry.type) {
      case 'Point':
        return [this.#screen(geometry.coordinates)]
      case 'MultiPoint':
      case 'LineString':
        return geometry.coordinates.map((c) => this.#screen(c))
      case 'MultiLineString':
      case 'Polygon':
        return geometry.coordinates.flat().map((c) => this.#screen(c))
      case 'MultiPolygon':
        return geometry.coordinates.flat(2).map((c) => this.#screen(c))
      case 'GeometryCollection':
        return geometry.geometries.flatMap((g) => this.#coordinates(g))
    }
  }

  #screen(position: Position): ScreenPoint {
    const lng = position[0]
    const lat = position[1]
    if (lng === undefined || lat === undefined) {
      throw new Error(
        `[blaeu] FakeRenderer met a geometry coordinate with fewer than two numbers: ${JSON.stringify(position)}.`,
      )
    }
    return this.project([lng, lat])
  }
}

/* ========================================================================= */
/* Web Mercator                                                              */
/* ========================================================================= */

/** 4326 → the unit square, [0,1]². The standard slippy-map projection. */
function mercator(lngLat: LngLat): readonly [number, number] {
  const lat = Math.min(Math.max(lngLat[1], -MAX_MERCATOR_LAT), MAX_MERCATOR_LAT)
  const x = (lngLat[0] + 180) / 360
  // asinh(tan φ) is the isometric latitude, and `Math.sinh` inverts it exactly — which
  // is what makes project/unproject exact inverses rather than merely close ones.
  const y = (1 - Math.asinh(Math.tan(lat * DEG2RAD)) / Math.PI) / 2
  return [x, y]
}

function unmercator(xy: readonly [number, number]): LngLat {
  const lng = xy[0] * 360 - 180
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * xy[1]))) * RAD2DEG
  return [lng, lat]
}

function rotate(x: number, y: number, radians: number): readonly [number, number] {
  if (radians === 0) return [x, y]
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return [x * cos - y * sin, x * sin + y * cos]
}

/* ========================================================================= */
/* Screen-space primitives                                                   */
/* ========================================================================= */

function distance(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function distanceToSegment(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return distance(p, a)
  const t = Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq, 0), 1)
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy })
}

function pointInRing(point: ScreenPoint, ring: readonly ScreenPoint[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!
    const b = ring[j]!
    const straddles = a.y > point.y !== b.y > point.y
    if (straddles && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

function inBox(
  p: ScreenPoint,
  box: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY
}

function syntheticEvent(type: string): Event {
  if (typeof Event === 'function') return new Event(type)
  // Older runtimes with no DOM `Event` global. Nothing in the kernel does more than
  // pass this through to a tool, so a structural stand-in is enough.
  return { type, preventDefault: () => {}, stopPropagation: () => {} } as unknown as Event
}
