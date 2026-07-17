/**
 * The edit session: what is being edited, what the handles are, and every mutation
 * the tools and the public API are allowed to make.
 *
 * The tools are thin on purpose — a tool turns pointer events into calls on this
 * object, and nothing else. Everything that could get the *geometry* wrong lives
 * here, once, where it can be read in one sitting and tested without a pointer.
 */

import {
  AddFeaturesCommand,
  RemoveFeaturesCommand,
  createId,
  distanceToGeometryMetres,
  type FeatureId,
  type BlaeuFeature,
  type Geometry,
  type LineString,
  type LngLat,
  type PluginContext,
  type ProjectedCrs,
  type ProjectedXY,
  type VertexRef,
} from '@blaeu/core'

import { CommitEditCommand, MoveVerticesCommand, SetGeometriesCommand } from './commands.js'
import { EditHandles, HANDLE_COLLECTIONS, handlesFor, type Handle } from './handles.js'
import {
  cornerCount,
  hasClosedRings,
  minimumCorners,
  planarBounds,
  ringOf,
  rotation,
  scaling,
  toLngLat,
  transformInPlane,
  translation,
  withVertexInserted,
  withVertexRemoved,
} from './geometry.js'
import { mergePolygons, splitPolygon } from './jsts.js'
import type { EditApi, ResolvedEditOptions } from './types.js'

/**
 * The API of the select plugin, as far as we need it.
 *
 * Structural, and deliberately *not* an import: `select` is an optional dependency,
 * and a plugin that imports another plugin to talk to it has re-coupled the two
 * (plugin-authoring skill, "if your plugin has to know about another plugin by
 * name, you picked the wrong extension point" — here we only need to know its id).
 * Duck-typed at the boundary so that a selection API which grows a field, or a
 * host that swaps in their own, keeps working.
 */
interface SelectionLike {
  readonly selected: readonly FeatureId[]
}

/**
 * A transform that is still under the user's finger.
 *
 * It carries the geometries **as they were at pointer-down**, and that is the whole
 * point of the type existing. A gesture previews a fresh transform on every
 * `pointermove`, each describing the total transform so far — so every frame must be
 * computed from the shape the drag started with. Recomputing from whatever is in the
 * store *now* applies frame 2's delta to frame 1's result: a 10 m drag over 10 frames
 * moves the parcel 55 m, a rotate winds up like a clock spring, and a scale runs away
 * exponentially. (The store holds the previous frame's preview, not a scratchpad you
 * can read back mid-gesture.)
 */
export interface TransformGesture {
  /** Identifies the gesture, so its frames belong to one commit. */
  readonly id: string
  /** The originals, captured once, at pointer-down. */
  readonly originals: ReadonlyMap<FeatureId, Geometry>
}

/**
 * The state an in-progress interactive edit accumulates so it can be committed, once,
 * on release.
 *
 * Every `pointermove` writes a transient *preview* — fast, unvalidated, never in
 * history — and records here the pre-edit snapshot of each feature the gesture has
 * touched (captured the first time it touches each, before any preview mutates it).
 * On `pointerup` the controller commits the final geometry through the pipeline with
 * `previous` taken from this snapshot, so validation and derived fields run on the
 * finished shape and undo restores the state from before the drag began — one step.
 */
interface PendingEdit {
  readonly gesture: string
  type: string
  label: string
  /** Pre-edit features, keyed by id, captured lazily as the gesture first touches each. */
  readonly previous: Map<FeatureId, BlaeuFeature>
}

export class EditController {
  readonly handles: EditHandles

  readonly #ctx: PluginContext<unknown>
  readonly #options: ResolvedEditOptions
  #editing: FeatureId | null = null
  /** Set by whichever tool is active, so that a transform's gizmo is not clobbered by vertex handles. */
  #renderHandles: (() => void) | undefined
  /** The interactive edit being previewed, awaiting its single commit on release. */
  #pending: PendingEdit | undefined

  constructor(ctx: PluginContext<unknown>, options: ResolvedEditOptions) {
    this.#ctx = ctx
    this.#options = options
    this.handles = new EditHandles(ctx)
  }

  get options(): ResolvedEditOptions {
    return this.#options
  }

  get editing(): FeatureId | null {
    return this.#editing
  }

  /** The plane every precise number in this plugin is computed in (core invariant 3). */
  get plane(): ProjectedCrs {
    return this.#ctx.crs.working
  }

  /* ===================================================================== */
  /* Session                                                               */
  /* ===================================================================== */

  edit(id: FeatureId): void {
    const feature = this.#require(id)
    if (feature.meta.locked === true) {
      throw new Error(
        `[blaeu/edit] feature "${id}" is locked and cannot be edited. ` +
          `Unlock it first (meta.locked = false) if the user is allowed to change it.`,
      )
    }

    if (this.#editing !== null && this.#editing !== id) this.stop()

    this.#editing = id
    this.refreshHandles()
    this.#ctx.events.emit('edit:start', { id, feature })

    // The vertex tool is the default editing mode. Activating it here means
    // `map.plugin('edit').edit(id)` is the whole of "let the user edit this",
    // which is what a host app's "Edit" button wants to call.
    if (this.#ctx.tools.active !== 'edit:vertex') this.#ctx.tools.activate('edit:vertex')
  }

  stop(): void {
    const id = this.#editing
    if (id === null) return

    const feature = this.#ctx.store.find(id)
    const gate = this.#ctx.events.emitCancellable('before:edit:complete', { id, feature })
    // A veto is a decision, not an error: a validation plugin refusing to let the
    // user walk away from a self-intersecting parcel is behaving correctly.
    if (!gate.allowed) return

    this.#editing = null
    this.handles.clear()
    this.#ctx.events.emit('edit:complete', { id, feature })
  }

  /**
   * Lets the active tool own what the handle layers show.
   *
   * The transform gizmo and the vertex handles are two different answers to "what is
   * grabbable right now", and both are rebuilt after every command. Without this
   * hook, the first geometry change during a rotate would repaint the vertex handles
   * over the gizmo the user is still dragging.
   *
   * Passing `undefined` restores the default (the edited feature's vertices).
   */
  setHandleRenderer(render: (() => void) | undefined): void {
    this.#renderHandles = render
    this.refreshHandles()
  }

  /** Rebuilds the handles from the store. Called after every geometry change. */
  refreshHandles(): void {
    if (this.#renderHandles !== undefined) {
      this.#renderHandles()
      return
    }

    const id = this.#editing
    if (id === null) return

    const feature = this.#ctx.store.find(id)
    if (feature === undefined) {
      // The feature was deleted (or split) out from under us. Ending the session is
      // the only honest response — the alternative is handles floating over nothing.
      this.#editing = null
      this.handles.clear()
      return
    }

    this.handles.set(handlesFor(feature, this.plane, (point) => this.#sharedWith(point).length > 1))
  }

  /* ===================================================================== */
  /* Gesture lifecycle — preview while dragging, commit once on release     */
  /* ===================================================================== */

  /**
   * Start (or continue) the pending edit for an interactive gesture.
   *
   * The first frame of a gesture opens a fresh pending; later frames keep the same
   * one (and its pre-edit snapshot), only updating the operation label — an insert
   * that becomes a drag is one gesture and owes exactly one Ctrl-Z. A new gesture
   * arriving while an old one is still open means the old one never released (an
   * interrupted drag); we flush it rather than silently lose the edit.
   */
  #beginPending(gesture: string, type: string, label: string): void {
    const pending = this.#pending
    if (pending && pending.gesture === gesture) {
      pending.type = type
      pending.label = label
      return
    }
    if (pending) this.#flushPending()
    this.#pending = { gesture, type, label, previous: new Map() }
  }

  /** Snapshot each feature's pre-edit state the first time the gesture touches it. */
  #capturePrevious(ids: Iterable<FeatureId>): void {
    const pending = this.#pending
    if (pending === undefined) return
    for (const id of ids) {
      if (pending.previous.has(id)) continue
      const feature = this.#ctx.store.find(id)
      if (feature !== undefined) pending.previous.set(id, feature)
    }
  }

  /**
   * End the gesture and commit its net effect once, through the pipeline.
   *
   * The tools call this on `pointerup`. `previous` is the pre-edit snapshot; `next` is
   * whatever the previews left in the store. The commit validates the finished shape
   * and stamps derived fields; if a rule vetoes it, the pre-edit geometry is put back.
   * One durable, validated write, one undo step — after a gesture's worth of previews.
   */
  commitGesture(): void {
    this.#flushPending()
  }

  /** Abandon the gesture and roll the preview back to the pre-edit geometry (Escape). */
  cancelGesture(): void {
    const pending = this.#pending
    this.#pending = undefined
    if (pending === undefined) return
    this.#revert([...pending.previous.values()])
    this.refreshHandles()
  }

  #flushPending(): void {
    const pending = this.#pending
    this.#pending = undefined
    if (pending === undefined) return

    const previous = [...pending.previous.values()]
    const next: BlaeuFeature[] = []
    for (const feature of previous) {
      const current = this.#ctx.store.find(feature.id)
      if (current !== undefined) next.push(current)
    }
    if (next.length === 0) return
    this.#commit(previous, next, pending.type, pending.label)
  }

  /**
   * A one-shot edit — a vertex delete, or a programmatic `move`/`rotate`/`scale`.
   *
   * It still previews-then-commits, collapsed to a single frame: a transient write
   * lands the new geometry synchronously (so a Delete key or an API call has immediate
   * effect and the handles are current), and the durable commit runs the pipeline
   * right behind it. Capturing `previous` *before* the preview is what keeps undo
   * pointing at the true pre-edit state.
   */
  #applyOnce(next: ReadonlyMap<FeatureId, Geometry>, type: string, label: string): void {
    const previous: BlaeuFeature[] = []
    const nextFeatures: BlaeuFeature[] = []
    for (const [id, geometry] of next) {
      const feature = this.#ctx.store.find(id)
      if (feature === undefined) continue
      previous.push(feature)
      nextFeatures.push({ ...feature, geometry })
    }
    if (nextFeatures.length === 0) return

    // Preview: land it now, synchronously, so the caller sees the effect immediately.
    this.#ctx.commands.dispatch(new SetGeometriesCommand(type, next, { label, transient: true }))
    this.refreshHandles()
    this.#commit(previous, nextFeatures, type, label)
  }

  /** Commit the durable write, fire-and-forget; revert on a validation veto. */
  #commit(
    previous: readonly BlaeuFeature[],
    next: readonly BlaeuFeature[],
    type: string,
    label: string,
  ): void {
    void this.#ctx.commands
      .commit(new CommitEditCommand(previous, next, { type, label }))
      .then((result) => {
        if (result.ok) {
          this.refreshHandles()
          return
        }
        // The finished edit was vetoed: put the pre-edit geometry back rather than
        // leave an invalid shape on the map. The veto is the answer, not an undo step.
        this.#revert(previous)
        this.refreshHandles()
        this.#ctx.log.warn(`edit rejected: ${result.rejectedReason ?? 'unknown reason'}`)
      })
      .catch((err: unknown) => {
        this.#ctx.events.emit('map:error', {
          error: err instanceof Error ? err : new Error(String(err)),
          source: 'edit:commit',
        })
      })
  }

  /** Restore geometry to a captured pre-edit state, transiently (not an undo entry). */
  #revert(previous: readonly BlaeuFeature[]): void {
    if (previous.length === 0) return
    const geometries = new Map<FeatureId, Geometry>()
    for (const feature of previous) geometries.set(feature.id, feature.geometry)
    this.#ctx.commands.dispatch(
      new SetGeometriesCommand('edit:revert', geometries, {
        label: this.#t('edit.move'),
        transient: true,
      }),
    )
  }

  /* ===================================================================== */
  /* Vertex editing                                                        */
  /* ===================================================================== */

  /**
   * Every vertex that must move when this one does.
   *
   * In topological mode that is *every feature's* vertex on the same corner, taken
   * from the store's topology index — which keys on a **quantised** coordinate, so
   * two parcels whose corners were digitised 0.4 mm apart still count as sharing
   * one. Exact float equality here would let them drift apart under editing, and a
   * sliver between two parcels is a legal problem, not a rendering artefact.
   */
  refsAt(point: LngLat, fallback: VertexRef): readonly VertexRef[] {
    if (!this.#options.topological) return [fallback]

    const shared = this.#sharedWith(point)
    if (shared.length === 0) return [fallback]
    return shared
  }

  moveVertices(refs: readonly VertexRef[], from: LngLat, to: LngLat, gesture: string): void {
    const label = this.#t(refs.length > 1 ? 'edit.moveSharedVertex' : 'edit.moveVertex')
    this.#beginPending(gesture, 'edit:move-vertices', label)
    this.#capturePrevious(refs.map((ref) => ref.feature))

    // A transient preview: it draws the moved corner now, fast and unvalidated. `to`
    // is absolute, so this sets the vertex there regardless of the previous frame —
    // no accumulated float error over a long drag. The one validated write lands on
    // release, in commitGesture().
    const result = this.#ctx.commands.dispatch(
      new MoveVerticesCommand(refs, from, to, { gesture, label, transient: true }),
    )
    if (!result.ok) {
      this.#ctx.log.warn(
        `vertex move preview rejected: ${result.rejectedReason ?? 'unknown reason'}`,
      )
      return
    }

    const id = refs[0]?.feature
    if (id !== undefined) this.#ctx.events.emit('edit:vertex-move', { id, refs, from, to })
    this.refreshHandles()
  }

  /**
   * Inserts a vertex on the edge a midpoint handle sits on — and, in topological
   * mode, on the *same edge of every feature that shares it*.
   *
   * Without that second half, inserting a vertex on a shared boundary leaves the
   * neighbour with a straight edge where this parcel now has a bend, and the two
   * boundaries no longer describe the same line. The gap is invisible until someone
   * computes an area.
   *
   * @returns the refs of the newly inserted vertices, so the caller can keep dragging.
   */
  insertVertex(handle: Handle, at: LngLat, gesture: string): readonly VertexRef[] {
    const target = this.#require(handle.target)
    const edits = new Map<FeatureId, Geometry>()
    const refs: VertexRef[] = []

    edits.set(
      target.id,
      withVertexInserted(target.geometry, handle.part, handle.ring, handle.index, at),
    )
    refs.push({ feature: target.id, part: handle.part, ring: handle.ring, index: handle.index })

    if (this.#options.topological) {
      const [a, b] = this.#edgeEndpoints(target.geometry, handle)
      if (a !== undefined && b !== undefined) {
        for (const neighbour of this.#featuresSharingEdge(a, b, target.id)) {
          edits.set(
            neighbour.feature,
            withVertexInserted(
              this.#require(neighbour.feature).geometry,
              neighbour.part,
              neighbour.ring,
              neighbour.index,
              at,
            ),
          )
          refs.push(neighbour)
        }
      }
    }

    // An insert is the opening frame of a gesture: the tool immediately drags the new
    // vertex. Preview it (transient) and fold it into the pending edit, so the insert
    // and the drag commit together as one validated write and one undo step on release.
    const label = this.#t('edit.insertVertex')
    this.#beginPending(gesture, 'edit:insert-vertex', label)
    this.#capturePrevious(edits.keys())

    const result = this.#ctx.commands.dispatch(
      new SetGeometriesCommand('edit:insert-vertex', edits, { label, gesture, transient: true }),
    )
    if (!result.ok) {
      this.#ctx.log.warn(
        `vertex insert preview rejected: ${result.rejectedReason ?? 'unknown reason'}`,
      )
      return []
    }

    this.#ctx.events.emit('edit:vertex-add', { id: target.id, at, refs })
    this.refreshHandles()
    return refs
  }

  /**
   * Deletes a corner, in every feature that shares it when topological.
   *
   * Refuses the whole operation — rather than half of it — if any affected ring
   * would fall below its minimum. Deleting a corner from one parcel and refusing it
   * on the neighbour is precisely the drift this plugin exists to prevent.
   */
  deleteVertex(handle: Handle): void {
    if (!this.#options.allowVertexDelete) return

    const refs = this.refsAt(handle.point, {
      feature: handle.target,
      part: handle.part,
      ring: handle.ring,
      index: handle.index,
    })

    const edits = new Map<FeatureId, Geometry>()
    for (const ref of refs) {
      const feature = this.#require(ref.feature)
      const minimum = minimumCorners(feature.geometry, this.#options.minVertices)
      // Throws with an actionable message if the ring would collapse; letting it
      // propagate to the caller is deliberate, because a silent no-op on a Delete
      // key is indistinguishable from a broken keyboard.
      edits.set(
        ref.feature,
        withVertexRemoved(feature.geometry, ref.part, ref.ring, ref.index, minimum),
      )
    }

    // A delete is a discrete click, not a drag: apply it once — preview synchronously
    // (so the corner is gone the instant Delete is pressed) and commit through the
    // pipeline right behind it, so a rule may still veto it.
    this.#applyOnce(edits, 'edit:delete-vertex', this.#t('edit.deleteVertex'))
    this.#ctx.events.emit('edit:vertex-delete', { id: handle.target, at: handle.point, refs })
  }

  /* ===================================================================== */
  /* Transforms — all planar, all in metres                                */
  /* ===================================================================== */

  /** The geometries a gesture must be recomputed from on every frame. Capture once, at pointer-down. */
  originals(ids: readonly FeatureId[]): Map<FeatureId, Geometry> {
    const originals = new Map<FeatureId, Geometry>()
    for (const id of ids) originals.set(id, this.#require(id).geometry)
    return originals
  }

  /**
   * Applies a planar transform to the **originals**, not to the current geometry.
   *
   * That is the whole defence against float accumulation: a 200-frame rotate is 200
   * applications of *one* rotation to the shape as it was when the drag started —
   * not 200 rotations of 0.3° chained one after another, which is a shape that has
   * quietly grown and drifted by the time the mouse comes up.
   */
  applyTransform(
    originals: ReadonlyMap<FeatureId, Geometry>,
    transform: (xy: ProjectedXY) => ProjectedXY,
    options: { readonly type: string; readonly label: string; readonly gesture?: string },
  ): void {
    if (originals.size === 0) return

    const plane = this.plane
    const next = new Map<FeatureId, Geometry>()
    for (const [id, geometry] of originals) {
      next.set(id, transformInPlane(geometry, plane, transform))
    }

    // A one-shot call (the public API, a script) has no gesture: apply it once,
    // validated. An interactive frame has one: preview it now, commit on release.
    if (options.gesture === undefined) {
      this.#applyOnce(next, options.type, options.label)
      return
    }

    this.#beginPending(options.gesture, options.type, options.label)
    this.#capturePrevious(next.keys())
    const result = this.#ctx.commands.dispatch(
      new SetGeometriesCommand(options.type, next, {
        label: options.label,
        gesture: options.gesture,
        transient: true,
      }),
    )
    if (!result.ok) {
      this.#ctx.log.warn(`transform preview rejected: ${result.rejectedReason ?? 'unknown reason'}`)
      return
    }
    this.refreshHandles()
  }

  /**
   * The geometries a transform must be computed from.
   *
   * Mid-gesture that is the snapshot taken at pointer-down — never the store, which
   * already holds the previous frame's result. A one-shot call (the public API, a
   * script) has no gesture and reads the store, which is the same thing.
   */
  #baseline(
    ids: readonly FeatureId[],
    gesture: TransformGesture | undefined,
  ): ReadonlyMap<FeatureId, Geometry> {
    if (gesture === undefined) return this.originals(ids)
    // Only the features the caller still means to transform: a selection can change
    // between pointer-down and the frame in which it is read.
    const base = new Map<FeatureId, Geometry>()
    for (const id of ids) {
      const geometry = gesture.originals.get(id)
      if (geometry !== undefined) base.set(id, geometry)
    }
    return base
  }

  move(ids: readonly FeatureId[], delta: ProjectedXY, gesture?: TransformGesture): void {
    this.applyTransform(this.#baseline(ids, gesture), translation(delta[0], delta[1]), {
      type: 'edit:move',
      label: this.#t('edit.move'),
      ...(gesture !== undefined ? { gesture: gesture.id } : {}),
    })
  }

  rotate(
    ids: readonly FeatureId[],
    degrees: number,
    pivot?: LngLat,
    gesture?: TransformGesture,
  ): void {
    const originals = this.#baseline(ids, gesture)
    const centre = this.pivotFor([...originals.values()], pivot)
    if (centre === undefined) return
    this.applyTransform(originals, rotation(centre, degrees), {
      type: 'edit:rotate',
      label: this.#t('edit.rotate'),
      ...(gesture !== undefined ? { gesture: gesture.id } : {}),
    })
  }

  scale(
    ids: readonly FeatureId[],
    factor: number,
    pivot?: LngLat,
    gesture?: TransformGesture,
  ): void {
    if (!(factor > 0) || !Number.isFinite(factor)) {
      throw new Error(
        `[blaeu/edit] scale factor must be a positive, finite number; got ${factor}. ` +
          `A factor of 0 collapses the parcel to a point, and a negative one mirrors it — ` +
          `if you meant to mirror, say so explicitly.`,
      )
    }
    const originals = this.#baseline(ids, gesture)
    const centre = this.pivotFor([...originals.values()], pivot)
    if (centre === undefined) return
    this.applyTransform(originals, scaling(centre, factor), {
      type: 'edit:scale',
      label: this.#t('edit.scale'),
      ...(gesture !== undefined ? { gesture: gesture.id } : {}),
    })
  }

  /** The explicit pivot, projected — or the centre of the bounding box of what is being transformed. */
  pivotFor(geometries: readonly Geometry[], pivot: LngLat | undefined): ProjectedXY | undefined {
    if (pivot !== undefined) return this.plane.forward(pivot)
    return planarBounds(geometries, this.plane)?.centre
  }

  /* ===================================================================== */
  /* Split and merge                                                       */
  /* ===================================================================== */

  async split(id: FeatureId, line: LineString): Promise<void> {
    const feature = this.#require(id)
    // Throws, with a message naming what to do, if the line does not fully cross.
    // Deliberately *before* the transaction: nothing should have been touched when
    // a cut is refused.
    const parts = splitPolygon(feature.geometry, line, this.plane)

    let created: readonly BlaeuFeature[] = []
    // One undo step, two validated writes. The halves are committed — so a preset
    // rule that forbids a parcel below the minimum legal area (`ifraz` limits) can
    // refuse the cut — and if it does, `commitTransaction` rolls back the removal
    // too. A split that leaves the original deleted and no halves in its place is
    // the worst possible outcome, and it is the one this structure rules out.
    const result = await this.#ctx.commands.commitTransaction(this.#t('edit.split'), async () => {
      await this.#ctx.commands.commit(new RemoveFeaturesCommand([id]))
      const added = await this.#ctx.commands.commit(
        new AddFeaturesCommand(
          feature.meta.collection,
          parts.map((geometry) => ({
            // A fresh id per part: the original parcel is gone, and re-using its id
            // for one of the halves would make every reference to it silently mean
            // "the left half" — including references in a land registry.
            id: createId(),
            geometry,
            properties: { ...feature.properties },
            meta: { source: 'edit:split' },
          })),
        ),
      )
      created = added.value ?? []
    })

    if (!result.ok) {
      throw new Error(
        `[blaeu/edit] the split was rejected: ${result.rejectedReason ?? 'unknown reason'}. ` +
          `Nothing has been changed.`,
      )
    }

    if (this.#editing === id) {
      this.#editing = null
      this.handles.clear()
    }
    this.#ctx.events.emit('edit:split', { source: id, parts: created })
  }

  async merge(ids: readonly FeatureId[]): Promise<void> {
    const features = ids.map((id) => this.#require(id))
    const first = features[0]
    if (first === undefined || features.length < 2) {
      throw new Error(`[blaeu/edit] merge needs at least two features; got ${features.length}.`)
    }

    // Throws (with a message about contiguity) before anything is touched.
    const geometry = mergePolygons(
      features.map((feature) => feature.geometry),
      this.plane,
    )

    let created: BlaeuFeature | undefined
    const result = await this.#ctx.commands.commitTransaction(this.#t('edit.merge'), async () => {
      await this.#ctx.commands.commit(new RemoveFeaturesCommand(ids))
      const added = await this.#ctx.commands.commit(
        new AddFeaturesCommand(first.meta.collection, [
          {
            id: createId(),
            geometry,
            // The first feature's attributes win. Merging is not a data-fusion
            // problem this plugin is qualified to solve — a cadastre preset that
            // knows how to combine two parcels' `yuzolcumu` can listen for
            // `edit:merge` and correct it. (With the commit pipeline live, it does
            // better than listen: `deriveAreaMiddleware` recomputes the area of the
            // merged parcel on the way in, so the attribute cannot lie.)
            properties: { ...first.properties },
            meta: { source: 'edit:merge' },
          },
        ]),
      )
      created = added.value?.[0]
    })

    if (!result.ok || created === undefined) {
      throw new Error(
        `[blaeu/edit] the merge was rejected: ${result.rejectedReason ?? 'unknown reason'}. ` +
          `Nothing has been changed.`,
      )
    }

    if (this.#editing !== null && ids.includes(this.#editing)) {
      this.#editing = null
      this.handles.clear()
    }
    this.#ctx.events.emit('edit:merge', { sources: [...ids], feature: created })
  }

  /* ===================================================================== */
  /* What a transform tool operates on                                     */
  /* ===================================================================== */

  /**
   * The features a transform applies to: the selection if a select plugin is
   * installed and has one, otherwise whatever is being edited.
   *
   * The `select` dependency is optional and this is what "degrades" means — with no
   * selection plugin the transform gizmo still works, it just works on the feature
   * the user is editing rather than on a multi-feature selection.
   */
  targets(): readonly FeatureId[] {
    const selected = this.#selection()
    if (selected.length > 0) return selected
    return this.#editing === null ? [] : [this.#editing]
  }

  /**
   * The feature under the pointer, ignoring our own handles.
   *
   * Asks the *store*, not the renderer. `ctx.hits()` would only see the layers the
   * host happens to have declared — a perfectly ordinary app renders parcels as a
   * fill layer *and* an outline layer and might name neither of them what we guess —
   * whereas the store's spatial index knows about every feature there is. The
   * tolerance is converted from pixels to metres at the current zoom, so "close" still
   * means what it means to a user.
   */
  featureAt(point: LngLat, screenTolerancePx: number): BlaeuFeature | undefined {
    const tolerance = this.#metresPerPixel(point) * screenTolerancePx

    let best: BlaeuFeature | undefined
    let bestDistance = Infinity
    for (const id of this.#ctx.store.collections()) {
      if (HANDLE_COLLECTIONS.has(id)) continue
      // `nearest` is spatially indexed and already bounded by the tolerance; only the
      // handful of survivors are measured again, to pick a winner across collections.
      const candidate = this.#ctx.store.collection(id).nearest(point, tolerance)
      if (candidate === undefined || candidate.meta.locked === true) continue

      const distance = distanceToGeometryMetres(this.#ctx.crs, point, candidate.geometry)
      if (distance < bestDistance) {
        bestDistance = distance
        best = candidate
      }
    }
    return best
  }

  /** Ground resolution at `point`, from the renderer's own projection — bearing, zoom and all. */
  #metresPerPixel(point: LngLat): number {
    const screen = this.#ctx.renderer.project(point)
    const shifted = this.#ctx.renderer.unproject({ x: screen.x + 1, y: screen.y })
    const metres = this.#ctx.crs.distance(point, shifted)
    // A degenerate camera (zoom so high the projection saturates) must not make the
    // tolerance zero, or nothing is ever clickable.
    return metres > 0 ? metres : 1
  }

  #selection(): readonly FeatureId[] {
    // `tryPlugin`'s key is typed against the registry, which only knows the plugins
    // this app has installed — and we deliberately do not depend on plugin-select's
    // package, so its augmentation may not be loaded. Probe structurally instead.
    const probe = this.#ctx.tryPlugin as (id: string) => unknown
    const api = probe('select')
    if (!isSelectionLike(api)) return []
    return api.selected.filter((id) => this.#ctx.store.find(id) !== undefined)
  }

  /* ===================================================================== */
  /* Internals                                                             */
  /* ===================================================================== */

  /** Refs on this corner, minus our own handle points — which are features too. */
  #sharedWith(point: LngLat): readonly VertexRef[] {
    return this.#ctx.store.topology.at(point).filter((ref) => !this.#isHandle(ref.feature))
  }

  #isHandle(id: FeatureId): boolean {
    const feature = this.#ctx.store.find(id)
    return feature !== undefined && HANDLE_COLLECTIONS.has(feature.meta.collection)
  }

  /** The two corners a midpoint handle sits between. */
  #edgeEndpoints(
    geometry: Geometry,
    handle: Handle,
  ): readonly [LngLat | undefined, LngLat | undefined] {
    const positions = ringOf(geometry, handle.part, handle.ring)
    if (positions === undefined) return [undefined, undefined]

    const corners = cornerCount(positions, hasClosedRings(geometry))
    const before = handle.index - 1
    const after = handle.index % corners
    const a = positions[before]
    const b = positions[after]
    return [a === undefined ? undefined : toLngLat(a), b === undefined ? undefined : toLngLat(b)]
  }

  /**
   * Other features whose ring contains the edge `a`–`b` as two *adjacent* corners,
   * and where the new vertex would land in each.
   *
   * Adjacency is the whole test. Two parcels can both have corners at `a` and at
   * `b` without sharing the edge between them — a third parcel wedged between, an
   * L-shape that turns at both — and inserting a vertex into a ring that merely
   * passes through both corners would put a bend in a boundary nobody touched.
   */
  #featuresSharingEdge(a: LngLat, b: LngLat, exclude: FeatureId): VertexRef[] {
    const atA = this.#sharedWith(a)
    const atB = this.#sharedWith(b)
    const out: VertexRef[] = []

    for (const refA of atA) {
      if (refA.feature === exclude) continue
      const feature = this.#ctx.store.find(refA.feature)
      if (feature === undefined) continue

      const positions = ringOf(feature.geometry, refA.part, refA.ring)
      if (positions === undefined) continue
      const closed = hasClosedRings(feature.geometry)
      const corners = cornerCount(positions, closed)

      for (const refB of atB) {
        if (refB.feature !== refA.feature) continue
        if (refB.part !== refA.part || refB.ring !== refA.ring) continue

        const insertAt = adjacentInsertIndex(refA.index, refB.index, corners, closed)
        if (insertAt === undefined) continue
        out.push({
          feature: refA.feature,
          part: refA.part,
          ring: refA.ring,
          index: insertAt,
        })
      }
    }
    return out
  }

  #require(id: FeatureId): BlaeuFeature {
    const feature = this.#ctx.store.find(id)
    if (feature === undefined) {
      throw new Error(
        `[blaeu/edit] no feature "${id}" in the store. It may have been deleted, or split into ` +
          `new features with new ids — re-read the id from the store before editing.`,
      )
    }
    return feature
  }

  #t(key: string): string {
    return this.#ctx.i18n.t(key)
  }
}

/**
 * Where a vertex inserted between corners `i` and `j` belongs, or `undefined` when
 * they are not neighbours.
 */
function adjacentInsertIndex(
  i: number,
  j: number,
  corners: number,
  closed: boolean,
): number | undefined {
  if (j === i + 1) return j
  if (i === j + 1) return i
  if (closed && corners > 2) {
    // The wrap-around edge: the last corner joins back to the first, and the new
    // vertex goes at the end of the open ring — just before the closing coordinate.
    if ((i === corners - 1 && j === 0) || (j === corners - 1 && i === 0)) return corners
  }
  return undefined
}

function isSelectionLike(api: unknown): api is SelectionLike {
  if (api === null || typeof api !== 'object') return false
  const selected = (api as { selected?: unknown }).selected
  return Array.isArray(selected) && selected.every((id) => typeof id === 'string')
}

/** Everything the public API does, in terms of the controller. */
export function createApi(controller: EditController): EditApi {
  return {
    edit: (id) => controller.edit(id),
    stop: () => controller.stop(),
    get editing() {
      return controller.editing
    },
    split: (id, line) => controller.split(id, line),
    merge: (ids) => controller.merge(ids),
    rotate: (ids, degrees, pivot) => controller.rotate(ids, degrees, pivot),
    scale: (ids, factor, pivot) => controller.scale(ids, factor, pivot),
    move: (ids, delta) => controller.move(ids, delta),
  }
}
