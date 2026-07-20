import {
  AddFeaturesCommand,
  RemoveFeaturesCommand,
  createId,
  type FeatureInput,
  type BlaeuFeature,
  type LngLat,
  type PluginContext,
  type Tool,
} from '@blaeu/core'

import { ReplaceCollectionsCommand } from './commands.js'
import { geometryFeature, labelFeatures } from './labels.js'
import { measureFeature, measurePositions, type MeasureEnv } from './measurement.js'
import {
  DRAFT_COLLECTION,
  DRAFT_ID,
  DRAFT_LABEL_COLLECTION,
  LABEL_COLLECTION,
  MEASURE_COLLECTION,
  MIN_VERTICES,
  TOOL_IDS,
  type MeasureMode,
  type MeasureOptions,
  type Measurement,
} from './types.js'

/**
 * The one piece of state the plugin has: what the user is measuring right now.
 *
 * All three tools share it, because all three do the same thing — collect vertices,
 * rubber-band to the pointer, commit — and differ only in how many vertices they need
 * and which number they report. Three near-identical tool classes would be three
 * places to fix the double-click bug.
 *
 * Every store write below goes through the command bus (core invariant 2). The draft
 * writes are `transient`, so dragging the pointer across a parcel does not leave 200
 * entries in the undo stack; the commit is not, so one measurement is one Ctrl-Z.
 */
export class MeasureSession {
  readonly #ctx: PluginContext<MeasureOptions>
  readonly #env: MeasureEnv

  #mode: MeasureMode | null = null
  #vertices: LngLat[] = []
  #pointer: LngLat | null = null
  /** Whether anything is currently in the draft collections. Saves a dispatch per idle move. */
  #draftPainted = false

  constructor(ctx: PluginContext<MeasureOptions>, env: MeasureEnv) {
    this.#ctx = ctx
    this.#env = env
  }

  get mode(): MeasureMode | null {
    return this.#mode
  }

  /** Completed measurements, oldest first. Read straight from the store, so undo shrinks it. */
  get measurements(): readonly Measurement[] {
    return this.#ctx.store
      .collection(MEASURE_COLLECTION)
      .all()
      .map((feature) => this.#fromFeature(feature))
  }

  measureFeature(id: string): Measurement {
    const feature = this.#ctx.store.find(id)
    if (feature === undefined) {
      throw new Error(
        `[measure] measureFeature("${id}"): no such feature. ` +
          `Check the id against map.store.find("${id}") — a selection held across a delete is the usual cause.`,
      )
    }
    return measureFeature(this.#env, feature)
  }

  /* ===================================================================== */
  /* The gesture                                                           */
  /* ===================================================================== */

  begin(mode: MeasureMode): void {
    this.#vertices = []
    this.#pointer = null
    this.#mode = mode

    // `persist: false` is the ruler behaviour — one measurement on screen at a time.
    if (!this.#env.options.persist) void this.clear()

    this.#ctx.events.emit('measure:start', { mode })
  }

  /** The tool was deactivated. Drop the half-drawn shape; keep everything committed. */
  end(): void {
    this.cancel()
    this.#mode = null
  }

  /**
   * Adds a vertex at the pointer.
   *
   * `point` is `ctx.lngLat`, which has **already been through the interaction
   * pipeline** — so if the snap plugin is installed, this is a parcel corner, exactly,
   * to the millimetre, and this plugin contains not one line of snapping code. That
   * is the whole payoff of the middleware design: measuring between two corners
   * snaps to them because *something else* rewrote the pointer position before any
   * tool saw it, and the measure plugin has never heard of the snap plugin.
   */
  addVertex(point: LngLat): void {
    const mode = this.#mode
    if (mode === null) return

    const last = this.#vertices.at(-1)
    // A browser fires `click` before `dblclick`, so finishing a polygon by
    // double-clicking its last corner always delivers one extra click on that corner.
    // Dropping a vertex that lands on the previous one — compared on the working CRS's
    // precision grid, not by float equality — is what stops that becoming a
    // zero-length segment with a meaningless bearing.
    if (last !== undefined && this.#coincident(last, point)) return

    this.#vertices.push(point)

    // A bearing is a single line: two clicks and it is done. Making the user
    // double-click to finish a shape that cannot grow is pure ceremony.
    if (mode === 'bearing' && this.#vertices.length >= MIN_VERTICES.bearing) {
      void this.complete()
      return
    }

    this.#paintDraft()
  }

  /** The pointer moved. Redraws the rubber band, with its length already on it. */
  moveTo(point: LngLat): void {
    if (this.#mode === null) return
    this.#pointer = point
    this.#paintDraft()
  }

  /** Finishes the current shape. Returns `undefined` if there is not enough of it yet. */
  async complete(): Promise<Measurement | undefined> {
    const mode = this.#mode
    if (mode === null) return undefined

    const positions = [...this.#vertices]
    // A double-click on the second corner of an area is not an area. Silently doing
    // nothing is right here: the user is still drawing, and their next click continues.
    if (positions.length < MIN_VERTICES[mode]) return undefined

    const measurement = measurePositions(this.#env, createId(), mode, positions, false)
    const labels = labelFeatures(this.#env, measurement)
    const label = this.#ctx.i18n.t('measure.command.add')

    // One transaction, so a measurement is one undo step even though it writes
    // geometry and labels into two different collections. The draft clear inside it is
    // transient and drops out of the recorded composite.
    const result = await this.#ctx.commands.commitTransaction(label, async (tx) => {
      this.#clearDraft()
      await tx.commit(
        new AddFeaturesCommand(MEASURE_COLLECTION, [geometryFeature(measurement)], { label }),
      )
      // Labels are text anchors — a Point at a segment midpoint, or at the ring centroid, which
      // sits on no boundary at all. Left snappable they become spurious (and top-priority) snap
      // targets, so the pointer can jump to a measurement's centroid. Only the measurement
      // geometry above stays snappable.
      await tx.commit(new AddFeaturesCommand(LABEL_COLLECTION, labels.map(unsnappable), { label }))
    })

    if (!result.ok) {
      // A commit-pipeline veto (a validation rule that refuses geometry in this
      // collection, say) is a decision, not a crash. Leave the vertices where they are
      // so the user can adjust rather than redraw.
      this.#ctx.log.warn(`measurement was rejected: ${result.rejectedReason ?? 'unknown reason'}`)
      return undefined
    }

    this.#vertices = []
    this.#pointer = null
    this.#ctx.events.emit('measure:complete', { measurement })
    return measurement
  }

  /** Escape: abandon the shape in progress; a second Escape leaves the tool. */
  escape(): void {
    if (this.#vertices.length > 0) {
      this.cancel()
      return
    }
    this.#ctx.tools.deactivate()
  }

  cancel(): void {
    this.#vertices = []
    this.#pointer = null
    this.#clearDraft()
  }

  /* ===================================================================== */
  /* Committed measurements                                                */
  /* ===================================================================== */

  async clear(): Promise<void> {
    const geometry = this.#ctx.store.collection(MEASURE_COLLECTION).all()
    const labels = this.#ctx.store.collection(LABEL_COLLECTION).all()
    if (geometry.length === 0 && labels.length === 0) return

    const ids = [...geometry, ...labels].map((feature) => feature.id)
    // One command, both collections: `RemoveFeaturesCommand` captures which collection
    // each feature came from, so undo puts the labels back beside their geometry.
    await this.#ctx.commands.commit(
      new RemoveFeaturesCommand(ids, { label: this.#ctx.i18n.t('measure.command.clear') }),
    )
    this.#ctx.events.emit('measure:clear', { count: geometry.length })
  }

  /**
   * Re-derives every label. Called when the locale changes.
   *
   * Labels are a pure function of the measurement, so this is a redraw rather than an
   * edit — hence transient, and hence invisible to undo. Without it, switching to
   * Turkish would leave `1,234.56 m²` frozen on the map next to a toolbar that had
   * already switched.
   */
  relabel(): void {
    const measurements = this.measurements
    if (measurements.length === 0) {
      this.#paintDraft()
      return
    }

    const labels = measurements
      .flatMap((measurement) => labelFeatures(this.#env, measurement))
      .map(unsnappable)
    this.#ctx.commands.dispatch(
      new ReplaceCollectionsCommand([[LABEL_COLLECTION, labels]], {
        label: this.#ctx.i18n.t('measure.command.draft'),
      }),
    )
    this.#paintDraft()
  }

  /* ===================================================================== */
  /* The rubber band                                                       */
  /* ===================================================================== */

  #paintDraft(): void {
    const mode = this.#mode
    if (mode === null) return

    const positions = this.#draftPositions()
    if (positions.length < 2) {
      this.#clearDraft()
      return
    }

    const measurement = measurePositions(this.#env, DRAFT_ID, mode, positions, true)
    this.#replaceDraft(
      [geometryFeature(measurement)].map(unsnappable),
      // The labels include the rubber-band segment's own length, which is the number
      // the user is actually watching while they decide where to click.
      labelFeatures(this.#env, measurement).map(unsnappable),
    )
    this.#ctx.events.emit('measure:update', { mode, measurement })
  }

  #draftPositions(): readonly LngLat[] {
    const pointer = this.#pointer
    if (pointer === null) return this.#vertices

    const last = this.#vertices.at(-1)
    if (last !== undefined && this.#coincident(last, pointer)) return this.#vertices
    return [...this.#vertices, pointer]
  }

  #replaceDraft(geometry: readonly FeatureInput[], labels: readonly FeatureInput[]): void {
    this.#ctx.commands.dispatch(
      new ReplaceCollectionsCommand(
        [
          [DRAFT_COLLECTION, geometry],
          [DRAFT_LABEL_COLLECTION, labels],
        ],
        { label: this.#ctx.i18n.t('measure.command.draft') },
      ),
    )
    this.#draftPainted = true
  }

  #clearDraft(): void {
    if (!this.#draftPainted) return
    this.#replaceDraft([], [])
    this.#draftPainted = false
  }

  /** Equal on the working CRS's precision grid — 1 mm for a cadastral CRS. */
  #coincident(a: LngLat, b: LngLat): boolean {
    const qa = this.#ctx.crs.quantise(a)
    const qb = this.#ctx.crs.quantise(b)
    return qa[0] === qb[0] && qa[1] === qb[1]
  }

  #fromFeature(feature: BlaeuFeature): Measurement {
    const stored = feature.properties['mode']
    // A stored bearing is a two-point LineString. Re-reading it without its mode would
    // quietly demote it to a distance, and the plan would lose an angle.
    const mode = isMode(stored) ? stored : undefined
    return measureFeature(this.#env, feature, mode)
  }
}

function isMode(value: unknown): value is MeasureMode {
  return value === 'distance' || value === 'area' || value === 'bearing'
}

/**
 * The rubber band is scaffolding, not a snap target.
 *
 * Written plain, a draft feature defaults to `snappable`, so the snap engine offers the band
 * the pointer is dragging as a candidate — and snaps the pointer to the previous frame, pinning
 * the measurement to itself. Marking every draft feature non-snappable takes it out of the snap
 * index. The *committed* measurement is left snappable on purpose: that one a surveyor may
 * legitimately want to snap a later feature to.
 */
function unsnappable(feature: FeatureInput): FeatureInput {
  return { ...feature, meta: { ...feature.meta, snappable: false } }
}

/* ========================================================================= */
/* Tools                                                                     */
/* ========================================================================= */

/**
 * The three tools, which are the same tool three times.
 *
 * Notice how little is here. Every tool reads `ctx.lngLat` and nothing else: no
 * snapping, no grid lock, no ortho constraint, no coordinate quantisation — all of
 * that happened in the interaction pipeline, upstream, in middleware this file has
 * never heard of. A tool that is forty lines long is the *evidence* that the
 * architecture is working.
 */
export function measureTools(session: MeasureSession): readonly (readonly [string, Tool])[] {
  const modes: readonly MeasureMode[] = ['distance', 'area', 'bearing']
  return modes.map((mode) => [TOOL_IDS[mode], createTool(session, mode)] as const)
}

function createTool(session: MeasureSession, mode: MeasureMode): Tool {
  return {
    id: TOOL_IDS[mode],
    cursor: 'crosshair',

    activate: () => session.begin(mode),
    deactivate: () => session.end(),

    onClick: (ctx) => {
      session.addVertex(ctx.lngLat)
      return true
    },

    onPointerMove: (ctx) => {
      session.moveTo(ctx.lngLat)
      return true
    },

    onDblClick: () => {
      void session.complete()
      return true
    },

    onKeyDown: (ctx) => {
      if (ctx.key === 'Escape') {
        session.escape()
        return true
      }
      // Enter finishes without a double-click — the keyboard path a surveyor
      // digitising a long boundary will actually use.
      if (ctx.key === 'Enter') {
        void session.complete()
        return true
      }
      return false
    },
  }
}
