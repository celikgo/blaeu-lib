import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { polygon } from '@turf/helpers'
import { DisposableStore } from '@blaeu/core'
import type {
  CollectionId,
  Disposable,
  FeatureId,
  BlaeuFeature,
  InteractionContext,
  LngLat,
  PluginContext,
} from '@blaeu/core'
import { centroidOf, ringBbox } from './geometry.js'
import type { ResolvedSelectOptions } from './options.js'
import { SelectionOverlay } from './overlay.js'

export type SelectMode = 'replace' | 'add' | 'toggle' | 'subtract'

export type SelectionHandler = (ids: ReadonlySet<FeatureId>) => void

/**
 * The selection set, and the only thing allowed to change it.
 *
 * **Nothing here goes through the command bus, and that is deliberate.** Core
 * invariant 2 says every change to *the document* is a `Command`, so that undo has
 * a record of it. A selection is not the document: it is what the user is currently
 * pointing at. If it were undoable, Ctrl-Z after deleting three parcels would first
 * restore the fact that they had been selected — twice — before restoring the
 * parcels, and every user would read that as broken. Selection is transient state;
 * geometry is committed state; the two must not share a stack.
 */
export class SelectionController implements Disposable {
  readonly overlay: SelectionOverlay
  readonly options: ResolvedSelectOptions

  readonly #ctx: PluginContext<unknown>
  readonly #disposables = new DisposableStore()
  readonly #handlers = new Set<SelectionHandler>()
  #selected = new Set<FeatureId>()

  constructor(ctx: PluginContext<unknown>, options: ResolvedSelectOptions) {
    this.#ctx = ctx
    this.options = options
    this.overlay = new SelectionOverlay(ctx)
    this.#disposables.add(this.overlay)

    // A deleted feature that stays selected is a dangling id: the attribute panel
    // shows a ghost, and the next "delete selection" dispatches a command against a
    // feature that is not there. Prune eagerly.
    this.#disposables.add(
      ctx.events.on('feature:removed', (event) => {
        const gone = new Set(event.payload.features.map((f) => f.id))
        if (![...this.#selected].some((id) => gone.has(id))) return
        this.#apply(new Set([...this.#selected].filter((id) => !gone.has(id))))
      }),
    )

    // Geometry the user is dragging is geometry the highlight has to follow, or the
    // halo detaches from the parcel mid-drag.
    this.#disposables.add(
      ctx.events.on('feature:updated', (event) => {
        if (!event.payload.features.some((f) => this.#selected.has(f.id))) return
        this.#refresh()
      }),
    )

    this.#disposables.addFn(() => this.#handlers.clear())
  }

  /* ===================================================================== */
  /* Reads                                                                 */
  /* ===================================================================== */

  get selected(): ReadonlySet<FeatureId> {
    return this.#selected
  }

  get features(): readonly BlaeuFeature[] {
    const out: BlaeuFeature[] = []
    for (const id of this.#selected) {
      const feature = this.#ctx.store.find(id)
      if (feature !== undefined) out.push(feature)
    }
    return out
  }

  isSelectable(feature: BlaeuFeature): boolean {
    // Hidden is absolute: you cannot select what is not on the map, whatever the
    // options say. Locked is a policy, and the option is the policy switch.
    if (feature.meta.hidden === true) return false
    if (feature.meta.locked === true && !this.options.selectLocked) return false
    const only = this.options.collections
    if (only !== undefined && !only.includes(feature.meta.collection)) return false
    return true
  }

  /**
   * The topmost selectable feature under the pointer.
   *
   * `hits()` comes back topmost-first and may include our own overlay features —
   * the highlight source carries copies of the selected features, and the preview
   * source carries the marquee. Resolving every hit through the store filters the
   * marquee out (it is not in the store) and collapses a highlight copy back onto
   * the feature it copies.
   */
  pick(hits: readonly BlaeuFeature[]): BlaeuFeature | undefined {
    for (const hit of hits) {
      const feature = this.#ctx.store.find(hit.id)
      if (feature !== undefined && this.isSelectable(feature)) return feature
    }
    return undefined
  }

  /** Store-backed, selectable ids from a renderer query. Same filtering as {@link pick}. */
  selectableIds(hits: readonly BlaeuFeature[]): FeatureId[] {
    const out: FeatureId[] = []
    for (const hit of hits) {
      const feature = this.#ctx.store.find(hit.id)
      if (feature !== undefined && this.isSelectable(feature)) out.push(feature.id)
    }
    return out
  }

  /* ===================================================================== */
  /* Writes                                                                */
  /* ===================================================================== */

  select(ids: FeatureId | readonly FeatureId[], mode: SelectMode = 'replace'): void {
    const list = typeof ids === 'string' ? [ids] : ids
    const next = new Set<FeatureId>(mode === 'replace' ? [] : this.#selected)

    for (const id of list) {
      switch (mode) {
        case 'replace':
        case 'add':
          if (this.#isSelectableId(id)) next.add(id)
          break
        case 'subtract':
          // Never gated on selectability: a feature that was locked *after* being
          // selected must still be removable, or the user cannot clear it.
          next.delete(id)
          break
        case 'toggle':
          if (next.has(id)) next.delete(id)
          else if (this.#isSelectableId(id)) next.add(id)
          break
      }
    }

    this.#apply(next)
  }

  selectByFilter(fn: (feature: BlaeuFeature) => boolean): void {
    const next = new Set<FeatureId>()
    for (const collection of this.#collections()) {
      for (const feature of this.#ctx.store.collection(collection).all()) {
        if (this.isSelectable(feature) && fn(feature)) next.add(feature.id)
      }
    }
    this.#apply(next)
  }

  clear(): void {
    if (this.#selected.size === 0) return
    this.#apply(new Set())
  }

  /**
   * Everything whose centroid falls inside a freehand ring.
   *
   * The bbox pre-filter is not an optimisation, it is the difference between a
   * usable tool and a frozen tab: `collection.query()` hits the R-tree, so a lasso
   * over a corner of a 50 000-parcel layer tests the fifty parcels near the lasso,
   * not all fifty thousand. Point-in-polygon is cheap; calling it 50 000 times on
   * pointer-up is not.
   */
  idsInRing(ring: readonly LngLat[]): FeatureId[] {
    if (ring.length < 4) return []
    const lasso = polygon([ring.map((p) => [p[0], p[1]])])
    const bbox = ringBbox(ring)

    const out: FeatureId[] = []
    for (const collection of this.#collections()) {
      for (const feature of this.#ctx.store.collection(collection).query(bbox)) {
        if (!this.isSelectable(feature)) continue
        const centre = centroidOf(feature.geometry)
        if (centre === undefined) continue
        if (booleanPointInPolygon([centre[0], centre[1]], lasso)) out.push(feature.id)
      }
    }
    return out
  }

  onChange(handler: SelectionHandler): Disposable {
    this.#handlers.add(handler)
    return { dispose: () => this.#handlers.delete(handler) }
  }

  /** The mode a gesture means, given the modifiers the user is holding. */
  modeFor(ctx: InteractionContext, withModifier: SelectMode): SelectMode {
    // Alt-subtract is not in the option surface because it is not a preference: every
    // selection UI the user has met (Illustrator, QGIS, Figma) subtracts on alt.
    if (ctx.modifiers.alt) return 'subtract'
    return ctx.modifiers[this.options.multiKey] ? withModifier : 'replace'
  }

  dispose(): void {
    this.#disposables.dispose()
  }

  /* ===================================================================== */
  /* Internals                                                             */
  /* ===================================================================== */

  #isSelectableId(id: FeatureId): boolean {
    const feature = this.#ctx.store.find(id)
    // An id the store has never heard of is silently dropped rather than kept as a
    // pending selection: a set that contains ids with no features behind them makes
    // `features` and `selected` disagree, and every consumer then picks one at random.
    return feature !== undefined && this.isSelectable(feature)
  }

  /** Collections the selection is allowed to touch — the option, or all of them. */
  #collections(): readonly CollectionId[] {
    return this.options.collections ?? this.#ctx.store.collections()
  }

  #apply(next: Set<FeatureId>): void {
    const added = [...next].filter((id) => !this.#selected.has(id))
    const removed = [...this.#selected].filter((id) => !next.has(id))
    // A no-op selection must not emit: a UI that re-renders its attribute table on
    // every `select:changed` would otherwise redraw on every click inside an
    // already-selected parcel.
    if (added.length === 0 && removed.length === 0) return

    this.#selected = next
    this.#refresh()

    const payload = {
      selected: this.#selected as ReadonlySet<FeatureId>,
      added: added as readonly FeatureId[],
      removed: removed as readonly FeatureId[],
    }

    // The deltas, not just the set: a UI that has to diff two sets to find out which
    // row to un-highlight is a UI that re-renders the whole table on every click.
    this.#ctx.events.emit('select:changed', payload)
    for (const handler of [...this.#handlers]) {
      try {
        handler(this.#selected)
      } catch (err) {
        this.#ctx.log.error('a select onChange handler threw', err)
      }
    }
  }

  #refresh(): void {
    this.overlay.setSelected(this.features)
  }
}
