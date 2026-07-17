import type { Bbox, CollectionId, Disposable, FeatureId, LngLat } from '../types/common.js'
import type { CrsService } from '../types/crs.js'
import type { EventBus } from '../types/events.js'
import type {
  FeatureInput,
  FeatureMeta,
  FeatureProperties,
  BlaeuFeature,
} from '../types/feature.js'
import type { Collection, FeatureStore, StoreChange, StoreSnapshot } from '../types/store.js'
import type {
  Feature as GeoJsonFeature,
  FeatureCollection as GeoJsonFeatureCollection,
} from 'geojson'

import { SpatialIndex } from './SpatialIndex.js'
import { BlaeuTopologyIndex } from './TopologyIndex.js'
import { bboxAround, distanceToGeometryMetres, normaliseGeometry } from '../utils/geometry.js'
import { createId } from '../utils/ids.js'

/** Where `nearest()` starts looking when the caller sets no bound. Doubles until it finds something. */
const NEAREST_SEED_RADIUS_METRES = 25
/** Half the earth. A search that has grown this far is looking at an empty collection. */
const NEAREST_MAX_RADIUS_METRES = 20_000_000

/**
 * A named set of features, spatially indexed.
 *
 * Reads hand back the stored objects, not copies. That is deliberate — copying on
 * every read would allocate a megabyte per pointer move — and it is why `strict`
 * mode freezes them: the invariant "you do not mutate what the store gives you"
 * (core invariant 2) has to be *enforced* somewhere, or it is merely a wish.
 */
export class BlaeuCollection<
  P extends FeatureProperties = FeatureProperties,
> implements Collection<P> {
  readonly id: CollectionId

  readonly #crs: CrsService
  readonly #strict: boolean
  /** Insertion-ordered, which is also the order the renderer draws in. */
  readonly #features = new Map<FeatureId, BlaeuFeature<P>>()
  readonly #spatial = new SpatialIndex()

  constructor(id: CollectionId, crs: CrsService, strict: boolean) {
    this.id = id
    this.#crs = crs
    this.#strict = strict
  }

  get size(): number {
    return this.#features.size
  }

  get(id: FeatureId): BlaeuFeature<P> | undefined {
    const feature = this.#features.get(id)
    return feature === undefined ? undefined : this.#harden(feature)
  }

  has(id: FeatureId): boolean {
    return this.#features.has(id)
  }

  all(): readonly BlaeuFeature<P>[] {
    return [...this.#features.values()].map((f) => this.#harden(f))
  }

  /**
   * Features whose bounding box intersects `bbox`. O(log n) — see {@link SpatialIndex}.
   *
   * Bounding boxes, not geometries: an L-shaped parcel will come back for a query
   * in the notch of the L. Callers that need an exact answer (a click test) filter
   * the handful that come back; callers that need candidates (snapping) do not
   * care.
   */
  query(bbox: Bbox): readonly BlaeuFeature<P>[] {
    const out: BlaeuFeature<P>[] = []
    for (const id of this.#spatial.search(bbox)) {
      const feature = this.#features.get(id)
      if (feature !== undefined) out.push(this.#harden(feature))
    }
    return out
  }

  /**
   * The nearest feature by *true* distance to its geometry, in metres, measured in
   * the working plane. A point inside a polygon is at distance 0.
   *
   * The search grows a box outward from the point rather than scanning: at radius
   * r, every feature closer than r has a bbox intersecting the box, so the first
   * radius that yields a candidate at distance ≤ r has already found the global
   * nearest. That keeps the pointer path logarithmic in a 50 000-parcel
   * collection.
   */
  nearest(point: LngLat, maxDistanceMetres?: number): BlaeuFeature<P> | undefined {
    if (this.#features.size === 0) return undefined

    const limit = maxDistanceMetres ?? Infinity
    let radius = Math.min(limit, NEAREST_SEED_RADIUS_METRES)

    for (;;) {
      let best: BlaeuFeature<P> | undefined
      let bestDistance = Infinity

      for (const id of this.#spatial.search(bboxAround(this.#crs, point, radius))) {
        const feature = this.#features.get(id)
        if (feature === undefined) continue
        const distance = distanceToGeometryMetres(this.#crs, point, feature.geometry)
        if (distance < bestDistance) {
          bestDistance = distance
          best = feature
        }
      }

      // Only trustworthy once the winner is inside the disc we actually searched;
      // a candidate further away than the radius may be beaten by one whose bbox
      // the box missed.
      if (best !== undefined && bestDistance <= radius) {
        return bestDistance <= limit ? this.#harden(best) : undefined
      }
      if (radius >= limit || radius >= NEAREST_MAX_RADIUS_METRES) {
        return best !== undefined && bestDistance <= limit ? this.#harden(best) : undefined
      }
      radius = Math.min(radius * 2, limit, NEAREST_MAX_RADIUS_METRES)
    }
  }

  /**
   * A detached GeoJSON `FeatureCollection`.
   *
   * Deep-copied, and `meta` is dropped: this is an export boundary, callers do
   * mutate what they export, and our bookkeeping (`version`, `ext`) has no
   * business being POSTed to a customer's server (see the note on {@link FeatureMeta}).
   */
  toGeoJSON(): GeoJsonFeatureCollection {
    const features: GeoJsonFeature[] = this.all().map((feature) => ({
      type: 'Feature',
      id: feature.id,
      geometry: structuredClone(feature.geometry),
      properties: structuredClone(feature.properties) as GeoJsonFeature['properties'],
    }))
    return { type: 'FeatureCollection', features }
  }

  [Symbol.iterator](): Iterator<BlaeuFeature<P>> {
    return this.all()[Symbol.iterator]()
  }

  /** @internal Insert or replace. The store owns the meta; the collection owns the indexes. */
  _put(feature: BlaeuFeature<P>): void {
    const existing = this.#features.has(feature.id)
    this.#features.set(feature.id, feature)
    if (existing) this.#spatial.update(feature)
    else this.#spatial.insert(feature)
  }

  /** @internal */
  _delete(id: FeatureId): void {
    if (!this.#features.delete(id)) return
    this.#spatial.remove(id)
  }

  /** @internal Bulk replace — used by `restore()`. Bulk-loads the R-tree, which is ~10× faster. */
  _reset(features: readonly BlaeuFeature<P>[]): void {
    this.#features.clear()
    for (const feature of features) this.#features.set(feature.id, feature)
    this.#spatial.load(features)
  }

  /**
   * Freezes on the way out, once, and remembers it.
   *
   * A caller who violates invariant 2 by writing to a feature they read then fails
   * loudly, at the line that did it — instead of silently desyncing the renderer
   * and breaking undo three actions later, which is a genuinely horrible afternoon.
   */
  #harden(feature: BlaeuFeature<P>): BlaeuFeature<P> {
    if (!this.#strict) return feature
    return freezeFeature(feature)
  }
}

/**
 * The single source of truth for all geometry.
 *
 * Every write goes through `_add` / `_update` / `_remove`, which are `@internal`
 * and called only by commands. That is the whole of invariant 2, and everything
 * good downstream — undo, validation, a repainting renderer — follows from it.
 */
export class BlaeuFeatureStore implements FeatureStore {
  readonly topology: BlaeuTopologyIndex

  readonly #crs: CrsService
  readonly #events: EventBus
  readonly #strict: boolean
  readonly #collections = new Map<CollectionId, BlaeuCollection>()
  /** feature → collection. Lets `find()` and `_remove()` work without a collection id. */
  readonly #owner = new Map<FeatureId, CollectionId>()
  #changeHandlers: ((change: StoreChange) => void)[] = []

  constructor(crs: CrsService, events: EventBus, opts: { strict: boolean }) {
    this.#crs = crs
    this.#events = events
    this.#strict = opts.strict
    this.topology = new BlaeuTopologyIndex(crs, () => this.#everyFeature())
  }

  /**
   * Gets a collection, creating it if it doesn't exist.
   *
   * Auto-vivifying rather than throwing, because plugins legitimately reach for
   * `store.collection('default')` in `setup()` — before anything has been drawn —
   * and a kernel that throws there would force every plugin to write the same
   * three defensive lines.
   */
  collection<P extends FeatureProperties = FeatureProperties>(id: CollectionId): Collection<P> {
    return this.#ensure(id) as unknown as Collection<P>
  }

  collections(): readonly CollectionId[] {
    return [...this.#collections.keys()]
  }

  /** Idempotent: a preset and a plugin may both declare the same collection, and neither should lose. */
  createCollection(id: CollectionId): Collection {
    return this.#ensure(id)
  }

  /**
   * Drops a collection and everything in it.
   *
   * Emits the removals, because the renderer keeps its sources in sync from
   * `onChange` — a silent drop would leave 50 000 parcels painted on a map that no
   * longer has them.
   *
   * Not undoable: this is an application-level operation, not an edit. If a user
   * action should be undoable, express it as a `RemoveFeaturesCommand`.
   */
  removeCollection(id: CollectionId): void {
    const collection = this.#collections.get(id)
    if (collection === undefined) return

    const removed = collection.all()
    for (const feature of removed) {
      this.#owner.delete(feature.id)
      this.topology.deindex(feature.id)
    }
    this.#collections.delete(id)

    if (removed.length > 0) {
      this.#publish({ kind: 'remove', collection: id, features: removed, previous: removed })
      this.#events.emit('feature:removed', { features: removed })
    }
  }

  find(id: FeatureId): BlaeuFeature | undefined {
    const owner = this.#owner.get(id)
    if (owner === undefined) return undefined
    return this.#collections.get(owner)?.get(id)
  }

  /**
   * A structurally-shared snapshot of everything.
   *
   * Cheap: features are immutable, so the snapshot copies the *maps*, not the
   * geometry. Snapshotting a 50 000-parcel store is 50 000 pointer copies.
   *
   * Features come out **sorted by id**, not in insertion order. That is what makes
   * the undo round-trip test meaningful: removing a parcel and undoing puts it back
   * at the end of the insertion order, and a snapshot that preserved that order
   * would compare unequal to the original for a reason that means nothing to
   * anyone. A snapshot is a *value* — same features, same snapshot.
   *
   * Empty collections are omitted for the same reason. A collection is a namespace
   * that `collection(id)` conjures on demand, not state: merely *reading*
   * `store.collection('parcels')` would otherwise put it in the snapshot, and undoing
   * the first add to a fresh collection could never restore deep equality — it would
   * leave behind the empty collection the add had called into being. Snapshots
   * version features.
   */
  snapshot(): StoreSnapshot {
    const collections: Record<CollectionId, readonly BlaeuFeature[]> = {}
    for (const id of [...this.#collections.keys()].sort()) {
      const collection = this.#collections.get(id)!
      if (collection.size === 0) continue
      const features = collection.all().slice().sort(byId)
      collections[id] = Object.freeze(features)
    }
    return Object.freeze({
      collections: Object.freeze(collections),
      revision: revisionOf(collections),
    })
  }

  /**
   * Replaces the entire store, and tells everyone what moved.
   *
   * The diff matters. `restore()` is what a failed transaction rolls back to, and
   * a rollback that didn't emit would leave the renderer painting the half-split
   * parcel that the transaction just abandoned.
   */
  restore(snapshot: StoreSnapshot): void {
    const before = new Map<FeatureId, { feature: BlaeuFeature; collection: CollectionId }>()
    for (const [id, collection] of this.#collections) {
      for (const feature of collection.all()) before.set(feature.id, { feature, collection: id })
    }

    this.#collections.clear()
    this.#owner.clear()

    const changes: StoreChange[] = []
    const added: BlaeuFeature[] = []
    const updated: BlaeuFeature[] = []
    const updatedPrevious: BlaeuFeature[] = []

    for (const [id, features] of Object.entries(snapshot.collections)) {
      const collection = this.#ensure(id)
      collection._reset(features)

      const collectionAdded: BlaeuFeature[] = []
      const collectionUpdated: BlaeuFeature[] = []
      const collectionPrevious: BlaeuFeature[] = []

      for (const feature of features) {
        this.#owner.set(feature.id, id)
        const was = before.get(feature.id)
        before.delete(feature.id)

        if (was === undefined) {
          collectionAdded.push(feature)
        } else if (was.feature !== feature || was.collection !== id) {
          // Identity, not deep equality: features are immutable, so a different
          // object is a different value. A deep compare here would cost more than
          // the restore it is trying to describe.
          collectionUpdated.push(feature)
          collectionPrevious.push(was.feature)
        }
      }

      if (collectionAdded.length > 0) {
        changes.push({ kind: 'add', collection: id, features: collectionAdded, previous: [] })
        added.push(...collectionAdded)
      }
      if (collectionUpdated.length > 0) {
        changes.push({
          kind: 'update',
          collection: id,
          features: collectionUpdated,
          previous: collectionPrevious,
        })
        updated.push(...collectionUpdated)
        updatedPrevious.push(...collectionPrevious)
      }
    }

    // Whatever the snapshot didn't mention is gone.
    const removedByCollection = new Map<CollectionId, BlaeuFeature[]>()
    for (const { feature, collection } of before.values()) {
      const list = removedByCollection.get(collection) ?? []
      list.push(feature)
      removedByCollection.set(collection, list)
    }
    const removed: BlaeuFeature[] = []
    for (const [collection, features] of removedByCollection) {
      changes.push({ kind: 'remove', collection, features, previous: features })
      removed.push(...features)
    }

    this.topology.rebuild()

    for (const change of changes) this.#publish(change)
    if (added.length > 0) this.#events.emit('feature:added', { features: added })
    if (updated.length > 0) {
      this.#events.emit('feature:updated', { features: updated, previous: updatedPrevious })
    }
    if (removed.length > 0) this.#events.emit('feature:removed', { features: removed })
  }

  onChange(handler: (change: StoreChange) => void): Disposable {
    this.#changeHandlers.push(handler)
    return {
      dispose: () => {
        this.#changeHandlers = this.#changeHandlers.filter((h) => h !== handler)
      },
    }
  }

  /* ------------------------------------------------------------------ *
   * The internal write path. Commands call these; application code does not.
   * ------------------------------------------------------------------ */

  /**
   * @internal
   *
   * Ingest: mint an id, stamp the meta, and normalise the geometry **once** —
   * quantised to the working CRS's grid, rings wound RFC 7946 and closed. Doing it
   * here and only here is what lets every consumer downstream compare coordinates
   * exactly and trust the winding.
   *
   * A `FeatureInput` that already carries a full `meta` (the undo of a remove, an
   * import, a server sync) keeps it verbatim. That is not a special case bolted on
   * for undo — it is what makes `undo(execute(s))` restore *deep equality* rather
   * than "the same parcel, but its version is one higher and it was updated at a
   * different time".
   */
  _add(collection: CollectionId, features: readonly FeatureInput[]): readonly BlaeuFeature[] {
    const target = this.#ensure(collection)
    const added: BlaeuFeature[] = []

    for (const feature of this.materialise(collection, features)) {
      target._put(feature)
      this.#owner.set(feature.id, collection)
      this.topology.index(feature)
      added.push(feature)
    }

    if (added.length === 0) return added
    this.#publish({ kind: 'add', collection, features: added, previous: [] })
    this.#events.emit('feature:added', { features: added })
    return added
  }

  /**
   * Turn inputs into the features the store *would* write — and write nothing.
   *
   * This exists so the commit pipeline can show middleware the truth. A validation
   * rule asked to judge a parcel must see the parcel that will exist: id minted,
   * ring closed and wound RFC 7946, coordinates already snapped to the working
   * CRS's millimetre grid. Handed the raw `FeatureInput` instead, a rule would be
   * measuring geometry that is about to change under it — and a rule that passes
   * on the input but would have failed on the stored feature is not a weak rule,
   * it is a lie.
   *
   * Pure, and deliberately so: it is called on every commit, including the ones the
   * pipeline goes on to reject. Rejecting a write must not leave a minted id, a
   * touched topology index, or a `feature:added` event behind it.
   */
  materialise(
    collection: CollectionId,
    features: readonly FeatureInput[],
  ): readonly BlaeuFeature[] {
    const now = Date.now()
    // Ids claimed earlier *in this same batch*. The pre-materialise `_add` caught
    // duplicates for free, because it registered each feature before looking at the
    // next one; hoisting the minting out means we have to remember them ourselves.
    // Two features carrying the same explicit id in one import is a real thing, and
    // silently keeping only the last one is how half a shapefile goes missing.
    const claimed = new Set<FeatureId>()

    return features.map((input) => {
      const id = input.id ?? createId()
      const owner = this.#owner.get(id)
      if (owner !== undefined) {
        throw new Error(
          `[blaeu] cannot add feature "${id}" to "${collection}": that id is already in "${owner}". ` +
            `Use an UpdateFeaturesCommand to change it, or omit the id and let the store mint one.`,
        )
      }
      if (claimed.has(id)) {
        throw new Error(
          `[blaeu] cannot add feature "${id}" to "${collection}": the same id appears twice in one write.`,
        )
      }
      claimed.add(id)

      const { collection: _ignored, version, createdAt, updatedAt, ...rest } = input.meta ?? {}
      const meta: FeatureMeta = {
        ...rest,
        collection,
        version: version ?? 1,
        createdAt: createdAt ?? now,
        updatedAt: updatedAt ?? createdAt ?? now,
      }

      return this.#seal({
        id,
        geometry: normaliseGeometry(input.geometry, this.#crs, `feature "${id}"`),
        properties: input.properties ?? {},
        meta,
      })
    })
  }

  /**
   * @internal
   *
   * Writes a new version of features that already exist.
   *
   * The meta rule is worth reading twice, because it is the hinge the undo
   * contract hangs on:
   *
   * - The caller hands back a feature whose `meta.version` **matches** what we
   *   hold → this is an *edit*. We stamp the next version and `updatedAt`.
   * - The caller hands back a feature whose `meta.version` **differs** → they are
   *   not editing, they are *rewriting*: an undo restoring the version before the
   *   edit, a redo re-applying the version after it, a server sync asserting the
   *   truth. We take their meta verbatim.
   *
   * Without the second branch, every undo would leave the version one higher than
   * it found it, and `expect(store.snapshot()).toEqual(before)` — the one test that
   * catches real command bugs — could never pass for any command at all.
   */
  _update(features: readonly BlaeuFeature[]): readonly BlaeuFeature[] {
    const now = Date.now()
    const written: BlaeuFeature[] = []
    const previous: BlaeuFeature[] = []
    const grouped = new Map<CollectionId, { features: BlaeuFeature[]; previous: BlaeuFeature[] }>()

    for (const incoming of features) {
      const owner = this.#owner.get(incoming.id)
      if (owner === undefined) {
        throw new Error(
          `[blaeu] cannot update feature "${incoming.id}": it is not in the store. ` +
            `Add it with an AddFeaturesCommand first, or check that the id survived a round-trip through your API.`,
        )
      }
      const target = this.#collections.get(owner)!
      const prev = target.get(incoming.id)!

      const rewriting = incoming.meta.version !== prev.meta.version
      const meta: FeatureMeta = rewriting
        ? { ...incoming.meta, collection: owner }
        : {
            ...incoming.meta,
            collection: owner,
            createdAt: prev.meta.createdAt,
            version: prev.meta.version + 1,
            updatedAt: now,
          }

      const next: BlaeuFeature = this.#seal({
        id: incoming.id,
        geometry: normaliseGeometry(incoming.geometry, this.#crs, `feature "${incoming.id}"`),
        properties: incoming.properties,
        meta,
      })

      target._put(next)
      this.topology.reindex(next)

      written.push(next)
      previous.push(prev)
      const group = grouped.get(owner) ?? { features: [], previous: [] }
      group.features.push(next)
      group.previous.push(prev)
      grouped.set(owner, group)
    }

    if (written.length === 0) return written
    for (const [collection, group] of grouped) {
      this.#publish({
        kind: 'update',
        collection,
        features: group.features,
        previous: group.previous,
      })
    }
    this.#events.emit('feature:updated', { features: written, previous })
    return written
  }

  /**
   * @internal
   *
   * Removes what is there and returns it. Unknown ids are skipped rather than
   * thrown on: a selection can outlive the thing it selected, and deleting an
   * already-deleted parcel is a no-op, not an error. The return value is the
   * authority on what actually went — which is precisely what
   * `RemoveFeaturesCommand.undo()` puts back.
   */
  _remove(ids: readonly FeatureId[]): readonly BlaeuFeature[] {
    const removed: BlaeuFeature[] = []
    const grouped = new Map<CollectionId, BlaeuFeature[]>()

    for (const id of ids) {
      const owner = this.#owner.get(id)
      if (owner === undefined) continue
      const target = this.#collections.get(owner)!
      const feature = target.get(id)
      if (feature === undefined) continue

      target._delete(id)
      this.#owner.delete(id)
      this.topology.deindex(id)

      removed.push(feature)
      const group = grouped.get(owner) ?? []
      group.push(feature)
      grouped.set(owner, group)
    }

    if (removed.length === 0) return removed
    for (const [collection, features] of grouped) {
      this.#publish({ kind: 'remove', collection, features, previous: features })
    }
    this.#events.emit('feature:removed', { features: removed })
    return removed
  }

  /**
   * Freezes on the way *in*, not just on the way out of `get()`.
   *
   * The same object is handed to `onChange` handlers, to `feature:added`
   * listeners, and back to the command that wrote it — all of which are outside
   * the store and none of which may mutate it. Freezing once at the boundary makes
   * every one of those paths safe, and makes the read-path freeze a no-op.
   */
  #seal(feature: BlaeuFeature): BlaeuFeature {
    return this.#strict ? freezeFeature(feature) : feature
  }

  #ensure(id: CollectionId): BlaeuCollection {
    let collection = this.#collections.get(id)
    if (collection === undefined) {
      collection = new BlaeuCollection(id, this.#crs, this.#strict)
      this.#collections.set(id, collection)
    }
    return collection
  }

  *#everyFeature(): Iterable<BlaeuFeature> {
    for (const collection of this.#collections.values()) yield* collection.all()
  }

  /**
   * Change handlers run *before* the bus event.
   *
   * The renderer syncs from `onChange`, so by the time a plugin's
   * `feature:added` handler runs, what it sees on screen already matches what it
   * reads from the store. The other order produces a class of bug where a plugin
   * queries the renderer for a feature that the store swears exists.
   */
  #publish(change: StoreChange): void {
    for (const handler of [...this.#changeHandlers]) {
      try {
        handler(change)
      } catch (err) {
        this.#events.emit('map:error', {
          error: err instanceof Error ? err : new Error(String(err)),
          source: 'store:onChange',
        })
      }
    }
  }
}

function byId(a: BlaeuFeature, b: BlaeuFeature): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * A content fingerprint, **not** a write counter.
 *
 * A counter would be simpler and would also break the undo round-trip: execute
 * then undo returns the *content* to where it started, but a counter would be two
 * ahead, and `expect(store.snapshot()).toEqual(before)` would fail forever for a
 * reason that has nothing to do with the command under test. So: same features,
 * same revision — which is also what a collaboration plugin wants when it asks
 * "did anything actually change?".
 */
function revisionOf(collections: Record<CollectionId, readonly BlaeuFeature[]>): number {
  let hash = 0x811c9dc5
  for (const [id, features] of Object.entries(collections)) {
    hash = fnv1a(id, hash)
    for (const feature of features) {
      hash = fnv1a(`${feature.id}:${feature.meta.version}:${feature.meta.updatedAt}`, hash)
    }
  }
  return hash
}

function fnv1a(text: string, seed: number): number {
  let hash = seed
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function freezeFeature<P extends FeatureProperties>(feature: BlaeuFeature<P>): BlaeuFeature<P> {
  if (Object.isFrozen(feature)) return feature
  freezeDeep(feature.geometry)
  freezeDeep(feature.properties)
  freezeDeep(feature.meta)
  return Object.freeze(feature)
}

/** Freezes before recursing, so a (pathological) cyclic property bag terminates. */
function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  if (Object.isFrozen(value)) return
  Object.freeze(value)
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) freezeDeep(item)
    return
  }
  for (const item of Object.values(value)) freezeDeep(item)
}
