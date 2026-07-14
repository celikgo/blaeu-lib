import {
  AddFeaturesCommand,
  dedupeConsecutive,
  quantisePosition,
  toLngLat,
  type CollectionId,
  type FeatureInput,
  type FeatureProperties,
  type FlexiFeature,
  type Geometry,
  type LngLat,
  type PluginContext,
  type Position,
  type ScreenPoint,
} from '@fleximap/core'

import { PREVIEW_ID, SetPreviewCommand } from './preview.js'
import { resolveSnapHandle } from './snap-handle.js'
import type { DrawMode, ResolvedDrawOptions } from './types.js'

/** Undo-menu labels. Already the *user's* word for what they did, not the tool's. */
const LABELS: Readonly<Record<DrawMode, string>> = {
  point: 'Draw point',
  line: 'Draw line',
  polygon: 'Draw polygon',
  rectangle: 'Draw rectangle',
  circle: 'Draw circle',
  freehand: 'Draw freehand',
}

/**
 * The state every draw tool shares, and the one place a shape reaches the store.
 *
 * The tools are deliberately thin — a tool decides *when* a shape is finished and what
 * geometry it is; the session owns the vertices, the preview, the snap handshake, the
 * cancellable hook and the command dispatch. That split is why adding a seventh mode is a
 * forty-line file rather than a copy of the whole commit path.
 */
export class DrawSession {
  readonly #ctx: PluginContext<unknown>
  readonly #options: ResolvedDrawOptions

  #collection: CollectionId
  #mode: DrawMode | null = null
  #vertices: LngLat[] = []
  #hasPreview = false

  constructor(ctx: PluginContext<unknown>, options: ResolvedDrawOptions) {
    this.#ctx = ctx
    this.#options = options
    this.#collection = options.collection
  }

  get options(): ResolvedDrawOptions {
    return this.#options
  }

  get mode(): DrawMode | null {
    return this.#mode
  }

  get collection(): CollectionId {
    return this.#collection
  }

  /** A copy: `DrawApi.vertices` is handed to application code, which will mutate anything it can. */
  get vertices(): readonly LngLat[] {
    return [...this.#vertices]
  }

  /**
   * Retargets where subsequent shapes land.
   *
   * The shape in progress is *not* moved: it has no home yet, and a caller switching
   * collections halfway through a ring means the next shape, not this one.
   */
  setCollection(id: CollectionId): void {
    this.#collection = id
  }

  /* ---- lifecycle, driven by Tool.activate / Tool.deactivate ---- */

  begin(mode: DrawMode): void {
    this.#mode = mode
    this.#vertices = []
    this.#syncSnap()
    this.#ctx.events.emit('draw:start', { mode })
  }

  /** The tool is going away. Anything half-drawn is abandoned, and the snap engine is told. */
  end(): void {
    const mode = this.#mode
    const abandoned = this.#vertices.length > 0 || this.#hasPreview
    this.clearPreview()
    this.#vertices = []
    this.#mode = null
    this.#syncSnap()
    if (mode !== null && abandoned) {
      this.#ctx.events.emit('draw:cancel', { mode, reason: undefined })
    }
  }

  /** Discards the shape in progress. The tool stays active — Escape means "start over", not "stop". */
  cancel(reason?: string): void {
    const mode = this.#mode
    if (mode === null) return
    const abandoned = this.#vertices.length > 0 || this.#hasPreview
    this.clearPreview()
    this.#vertices = []
    this.#syncSnap()
    if (abandoned) {
      this.#ctx.events.emit('draw:cancel', { mode, reason })
    }
  }

  /* ---- vertices ---- */

  addVertex(point: LngLat): void {
    const mode = this.#mode
    if (mode === null) return
    this.#vertices.push(point)
    this.#syncSnap()
    this.#ctx.events.emit('draw:vertex', { mode, vertex: point, vertices: this.vertices })
  }

  /** Backspace. Returns false when there was nothing left to take back. */
  popVertex(): boolean {
    if (this.#vertices.length === 0) return false
    this.#vertices.pop()
    this.#syncSnap()
    return true
  }

  /**
   * The vertices as the store will really see them: quantised to the working CRS's
   * precision grid, with consecutive duplicates collapsed.
   *
   * Tools count *these*, never the raw click count, before deciding a ring has three
   * corners. Two clicks a tenth of a millimetre apart are two clicks to a mouse and one
   * corner to a land registry, and a tool that trusts the mouse hands the store a ring that
   * `normaliseRing` throws on.
   */
  distinctVertices(...extra: readonly LngLat[]): LngLat[] {
    const crs = this.#ctx.crs
    const positions: Position[] = [...this.#vertices, ...extra].map((p) =>
      quantisePosition([...p], crs),
    )
    return dedupeConsecutive(positions).map((p) => toLngLat(p))
  }

  /* ---- preview ---- */

  setPreview(geometry: Geometry | null): void {
    if (geometry === null) {
      this.clearPreview()
      return
    }
    this.#ctx.commands.dispatch(new SetPreviewCommand(geometry))
    this.#hasPreview = true
  }

  clearPreview(): void {
    if (!this.#hasPreview) return
    this.#ctx.commands.dispatch(new SetPreviewCommand(null))
    this.#hasPreview = false
  }

  /* ---- committing ---- */

  /**
   * The one path from a tool to the store.
   *
   * Two gates, and both leave no trace when they refuse. The cancellable
   * `before:draw:complete` hook fires first — that is for a *product* that wants to
   * intercept the gesture (a wizard that needs an attribute before it will accept a
   * shape). Then the commit pipeline runs, and that is where the *domain's* rules
   * live: a self-intersecting parcel, a building outside the zoning envelope, a
   * sounding deeper than the chart allows. Neither gate can leave a half-written
   * feature behind, because in both cases nothing has been written yet.
   *
   * Asynchronous because the second gate is: a real cadastral overlap check is a
   * round-trip to a parcel registry. The drawing tools do not await it — they fire
   * and forget, and the map updates on `draw:complete` when it lands.
   */
  async complete(
    geometry: Geometry,
    extraProperties: FeatureProperties = {},
  ): Promise<FlexiFeature | undefined> {
    const mode = this.#mode
    if (mode === null) return undefined

    const collection = this.#collection
    const input: FeatureInput = {
      geometry,
      properties: { ...this.#options.properties(), ...extraProperties },
      meta: { source: 'draw' },
    }

    const gate = this.#ctx.events.emitCancellable('before:draw:complete', {
      mode,
      collection,
      feature: input,
    })
    if (!gate.allowed) {
      this.cancel(gate.reason ?? 'vetoed by a before:draw:complete listener')
      return undefined
    }

    // Out before the commit, and transient, so the rubber band never appears in the
    // snapshot a history plugin would roll back to.
    this.clearPreview()

    const label = LABELS[mode]

    // `commit`, not `dispatch`: this is the write that makes the shape real, so it is
    // the write the product's rules get to refuse. In the cadastre preset, a polygon
    // whose ring crosses itself dies here — the store never sees it, and there is
    // nothing to roll back because nothing was written.
    const result = await this.#ctx.commands.commit(
      new AddFeaturesCommand(collection, [input], { label }),
    )

    this.#vertices = []
    this.#syncSnap()

    const created = result.value?.[0]
    if (!result.ok || created === undefined) {
      const reason = result.rejectedReason ?? 'the store did not return the drawn feature'
      this.#ctx.log.warn(`${label} was not committed: ${reason}`)
      this.#ctx.events.emit('draw:cancel', { mode, reason })
      return undefined
    }

    this.#ctx.events.emit('draw:complete', { mode, collection, feature: created })
    return created
  }

  /* ---- helpers the tools lean on ---- */

  project(lngLat: LngLat): ScreenPoint {
    return this.#ctx.renderer.project(lngLat)
  }

  /** Screen-pixel distance. "Close" to a user is a number of pixels, never a number of metres. */
  screenDistance(a: LngLat, b: LngLat): number {
    const p = this.project(a)
    const q = this.project(b)
    return Math.hypot(p.x - q.x, p.y - q.y)
  }

  get crs(): PluginContext<unknown>['crs'] {
    return this.#ctx.crs
  }

  get log(): PluginContext<unknown>['log'] {
    return this.#ctx.log
  }

  /**
   * Tells the snap engine what is in flight — if there is one.
   *
   * This is the *entire* contract between draw and snap, and it runs one way. The tools
   * never ask snap for a position; `ctx.lngLat` has already been snapped by the middleware
   * before a tool sees it. Everything here is guarded, so with no snap plugin installed the
   * whole handshake is three no-ops.
   */
  #syncSnap(): void {
    const snap = resolveSnapHandle(this.#ctx)
    if (snap === undefined) return
    snap.setInProgress?.(this.#vertices)
    snap.exclude?.(this.#mode === null ? [] : [PREVIEW_ID])
  }
}
