/**
 * The commands the edit plugin mutates the store with.
 *
 * Everything here obeys the contract that makes cross-plugin undo work:
 * **`undo(execute(s))` restores `s` to deep equality**. The way it is achieved is
 * the same trick the core's built-ins use — capture what the store *actually did*
 * (the stamped meta, the normalised geometry), not what we asked it to do, and
 * replay that verbatim on redo.
 *
 * Two things in here are specific to editing and worth reading before changing:
 *
 * 1. **Absolute targets, never per-frame deltas.** A drag dispatches a fresh
 *    command on every `pointermove`, each one describing the *whole* gesture so
 *    far. So a 200-frame drag applies one transform to the original geometry 200
 *    times, rather than 200 transforms in series — which would compound 200
 *    rounding errors and land the vertex somewhere the user did not drop it.
 *
 * 2. **Coalescing.** Those 200 commands must collapse into one undo step, or
 *    Ctrl-Z becomes useless the moment anyone actually edits anything. They merge
 *    only when they belong to the same gesture *and* touch the same features —
 *    tracked with a gesture id, because "the previous command was also a move" is
 *    not the same question as "the user is still holding the mouse down".
 */

import type {
  Command,
  CommandContext,
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

  /** The features as they were before this command first ran. The whole of `undo`. */
  #previous: readonly BlaeuFeature[] | undefined
  /** What the store wrote. Replayed on redo so a redo reproduces the first run exactly. */
  #written: readonly BlaeuFeature[] | undefined

  protected constructor(label: string) {
    this.label = label
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
    super(options.label ?? (refs.length > 1 ? 'Move shared vertex' : 'Move vertex'))
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
    super(options.label ?? 'Edit geometry')
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
