/**
 * The commands the edit plugin mutates the store with.
 *
 * Everything here obeys the contract that makes cross-plugin undo work:
 * **`undo(execute(s))` restores `s` to deep equality**. The way it is achieved is
 * the same trick the core's built-ins use — capture what the store *actually did*
 * (the stamped meta, the normalised geometry), not what we asked it to do, and
 * replay that verbatim on redo.
 *
 * The write path an interactive edit takes:
 *
 * - **During a drag**, every `pointermove` dispatches one of these as a *transient
 *   preview* — it redraws the geometry but is never recorded in history and never
 *   validated. Mid-drag geometry is legitimately invalid (a polygon self-intersects
 *   halfway through a reshape), so validating each frame would be both slow and wrong.
 * - **On release**, the controller commits a single {@link CommitEditCommand} through
 *   the pipeline: the one durable, validated write, one undo step. See the controller.
 *
 * One thing here is load-bearing and worth reading before changing:
 *
 * **Absolute targets, never per-frame deltas.** Each frame describes the *whole*
 * gesture so far — `to` is where the vertex should end up, not how far it moved this
 * frame. So a 200-frame drag sets the vertex to one absolute position 200 times rather
 * than summing 200 deltas, which would compound 200 rounding errors and land it
 * somewhere the user did not drop it.
 *
 * `coalesceWith` remains for a caller that dispatches these *durably* (not transient)
 * and wants a run of them to collapse into one undo step — it is no longer how the
 * interactive drag works, which previews and commits once instead.
 */

import type {
  Command,
  CommandContext,
  CommitCommand,
  CommitIntent,
  FeatureId,
  BlaeuFeature,
  Geometry,
  LngLat,
  VertexRef,
} from '@blaeu/core'
import { withVerticesMoved } from './geometry.js'

export interface EditCommandOptions {
  /** Already localised — it goes straight into the undo menu. */
  readonly label?: string
  /** Identifies the gesture. Two commands merge only if they share one. */
  readonly gesture?: string
  /**
   * A preview frame, not a durable write: it updates the geometry on screen but is
   * never recorded in history and never validated. A drag dispatches one of these per
   * `pointermove`; the single durable, validated write happens once on release (see
   * {@link CommitEditCommand}). Mid-drag geometry is *legitimately* invalid — a
   * self-intersecting polygon halfway through a reshape — so running the commit
   * pipeline on every frame would be both slow and wrong.
   */
  readonly transient?: boolean
}

/**
 * Rewrites the geometry of a set of features, reversibly.
 *
 * Subclasses say *which* features and *what* geometry; the capture/replay/undo
 * machinery is here, once, because getting it subtly wrong is how an undo stack
 * rots — and it rots silently, three user actions after the bug.
 */
export abstract class GeometryEditCommand implements Command<readonly BlaeuFeature[]> {
  abstract readonly type: string
  readonly label: string
  /** True for a per-frame drag preview: it draws but is never recorded or validated. */
  readonly transient: boolean

  /** The features as they were before this command first ran. The whole of `undo`. */
  #previous: readonly BlaeuFeature[] | undefined
  /** What the store wrote. Replayed on redo so a redo reproduces the first run exactly. */
  #written: readonly BlaeuFeature[] | undefined

  protected constructor(label: string, transient = false) {
    this.label = label
    this.transient = transient
  }

  /** The features this command touches, in a stable order. */
  protected abstract featureIds(): readonly FeatureId[]

  /** The new geometry for one feature, given its state before the command ran. */
  protected abstract rewrite(feature: BlaeuFeature): Geometry

  execute(ctx: CommandContext): readonly BlaeuFeature[] {
    if (this.#previous === undefined) {
      this.#previous = this.featureIds().map((id) => {
        const feature = ctx.store.find(id)
        if (feature === undefined) {
          throw new Error(
            `[blaeu/edit] cannot edit feature "${id}": it is not in the store. ` +
              `It was probably deleted while the edit session was still open — call edit.stop() when ` +
              `the feature being edited goes away.`,
          )
        }
        return feature
      })
    }

    const next =
      this.#written ??
      this.#previous.map((feature) => ({ ...feature, geometry: this.rewrite(feature) }))

    this.#written = ctx.store._update(next)
    return this.#written
  }

  undo(ctx: CommandContext): void {
    if (this.#previous === undefined || this.#previous.length === 0) return
    ctx.store._update(this.#previous)
  }

  /**
   * Take the merged command's history from the two it replaces: the *earlier*
   * command's "before" (so one Ctrl-Z steps back past the whole drag) and the
   * *later* command's "after" (so redo lands where the pointer was released).
   *
   * Called by a subclass's `coalesceWith` on the freshly-built merged instance,
   * which is never executed — it inherits both ends of the gesture instead.
   */
  protected adopt(earlier: GeometryEditCommand, later: GeometryEditCommand): void {
    this.#previous = earlier.#previous
    this.#written = later.#written
  }
}

/**
 * Moves one vertex — or, in topological mode, every vertex coincident with it,
 * across every feature that shares the corner, **in one command**.
 *
 * That last part is the whole reason this class exists rather than a generic
 * "set geometry". Two adjacent parcels share a corner; dragging it must move both,
 * and undoing must restore both. A system that moves one and leaves the other has
 * not produced a rendering artefact, it has produced a 3 cm strip of land with no
 * owner — and a legal problem, discovered years later by someone with a theodolite.
 */
export class MoveVerticesCommand extends GeometryEditCommand {
  readonly type = 'edit:move-vertices'

  readonly refs: readonly VertexRef[]
  /** Where the gesture started. Kept so a coalesced drag still knows its origin. */
  readonly from: LngLat
  readonly to: LngLat
  readonly gesture: string | undefined

  constructor(
    refs: readonly VertexRef[],
    from: LngLat,
    to: LngLat,
    options: EditCommandOptions = {},
  ) {
    super(
      options.label ?? (refs.length > 1 ? 'Move shared vertex' : 'Move vertex'),
      options.transient,
    )
    if (refs.length === 0) {
      throw new Error('[blaeu/edit] MoveVerticesCommand needs at least one vertex to move.')
    }
    this.refs = refs
    this.from = from
    this.to = to
    this.gesture = options.gesture
  }

  protected override featureIds(): readonly FeatureId[] {
    return [...new Set(this.refs.map((ref) => ref.feature))]
  }

  protected override rewrite(feature: BlaeuFeature): Geometry {
    const mine = this.refs.filter((ref) => ref.feature === feature.id)
    // `to` is absolute, so the result is the same whether this runs against the
    // original geometry or against the previous frame's — which is exactly the
    // property that keeps a long drag from accumulating float error.
    return withVerticesMoved(feature.geometry, mine, this.to)
  }

  coalesceWith(previous: Command): Command | null {
    if (!(previous instanceof MoveVerticesCommand)) return null
    // No gesture means a programmatic move — a script setting a coordinate — and two
    // of those are two edits, however close together they arrive.
    if (this.gesture === undefined || previous.gesture !== this.gesture) return null
    if (!sameRefs(previous.refs, this.refs)) return null

    const merged = new MoveVerticesCommand(this.refs, previous.from, this.to, {
      label: this.label,
      gesture: this.gesture,
    })
    merged.adopt(previous, this)
    return merged
  }
}

/**
 * Replaces the geometry of one or more features outright.
 *
 * The workhorse behind vertex insert/delete and the transform gizmo. The caller
 * computes the target geometry — from the *original*, plus the total transform of
 * the gesture so far — and this command carries it to the store and back.
 */
export class SetGeometriesCommand extends GeometryEditCommand {
  readonly type: string
  readonly gesture: string | undefined

  readonly #next: ReadonlyMap<FeatureId, Geometry>

  constructor(
    type: string,
    next: ReadonlyMap<FeatureId, Geometry>,
    options: EditCommandOptions = {},
  ) {
    super(options.label ?? 'Edit geometry', options.transient)
    if (next.size === 0) {
      throw new Error('[blaeu/edit] SetGeometriesCommand needs at least one feature to rewrite.')
    }
    this.type = type
    this.#next = next
    this.gesture = options.gesture
  }

  protected override featureIds(): readonly FeatureId[] {
    return [...this.#next.keys()]
  }

  protected override rewrite(feature: BlaeuFeature): Geometry {
    const geometry = this.#next.get(feature.id)
    if (geometry === undefined) {
      throw new Error(
        `[blaeu/edit] SetGeometriesCommand has no geometry for "${feature.id}", which it claimed to touch.`,
      )
    }
    return geometry
  }

  coalesceWith(previous: Command): Command | null {
    if (!(previous instanceof SetGeometriesCommand)) return null
    if (previous.type !== this.type) return null
    if (this.gesture === undefined || previous.gesture !== this.gesture) return null
    if (!sameIds(previous.featureIds(), this.featureIds())) return null

    const merged = new SetGeometriesCommand(this.type, this.#next, {
      label: this.label,
      gesture: this.gesture,
    })
    merged.adopt(previous, this)
    return merged
  }
}

/**
 * The one durable, validated write an interactive edit produces — committed on
 * release, after a gesture's worth of transient previews.
 *
 * Unlike the built-in `UpdateFeaturesCommand`, this carries its *own* `previous`
 * rather than reading it from the store at commit time. It has to: by the time a drag
 * ends, the store already holds the previewed (final) geometry, so a command that read
 * "the state before" out of the store would read the final state and undo to a no-op.
 * The controller captures the true pre-edit features when the gesture starts and hands
 * them here, so undo walks all the way back past the whole drag — one Ctrl-Z, exactly.
 *
 * Because it is a {@link CommitCommand}, `commit()` runs it through the pipeline: the
 * preset's derived fields (a cadastral area) get re-stamped on the final geometry, and
 * a validation rule gets its veto — the very things the per-frame preview skips.
 */
export class CommitEditCommand implements CommitCommand<readonly BlaeuFeature[]> {
  readonly type: string
  readonly label: string

  readonly #previous: readonly BlaeuFeature[]
  #next: readonly BlaeuFeature[]
  #written: readonly BlaeuFeature[] | undefined

  constructor(
    previous: readonly BlaeuFeature[],
    next: readonly BlaeuFeature[],
    options: { readonly type: string; readonly label: string },
  ) {
    if (next.length === 0) {
      throw new Error('[blaeu/edit] CommitEditCommand needs at least one feature to write.')
    }
    this.type = options.type
    this.label = options.label
    this.#previous = previous
    this.#next = next
  }

  intent(): CommitIntent {
    return { operation: 'update', features: this.#next, previous: this.#previous }
  }

  adopt(features: readonly BlaeuFeature[]): void {
    this.#next = features
  }

  execute(ctx: CommandContext): readonly BlaeuFeature[] {
    // Replay `#written` on redo (not `#next`) so a redo reproduces the first write
    // exactly — same version, same updatedAt — the store taking a meta it did not
    // stamp itself verbatim.
    this.#written = ctx.store._update(this.#written ?? this.#next)
    return this.#written
  }

  undo(ctx: CommandContext): void {
    if (this.#previous.length === 0) return
    ctx.store._update(this.#previous)
  }
}

function sameRefs(a: readonly VertexRef[], b: readonly VertexRef[]): boolean {
  if (a.length !== b.length) return false
  const key = (ref: VertexRef): string => `${ref.feature}:${ref.part}:${ref.ring}:${ref.index}`
  const set = new Set(b.map(key))
  return a.every((ref) => set.has(key(ref)))
}

function sameIds(a: readonly FeatureId[], b: readonly FeatureId[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((id) => set.has(id))
}
