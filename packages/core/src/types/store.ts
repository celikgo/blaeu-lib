import type { Bbox, CollectionId, Disposable, FeatureId, LngLat } from './common.js'
import type { FeatureInput, FeatureProperties, BlaeuFeature, VertexRef } from './feature.js'
import type { FeatureCollection as GeoJsonFeatureCollection } from 'geojson'

/** A named set of features. Maps 1:1 to a renderer source, and is the unit of styling. */
export interface Collection<P extends FeatureProperties = FeatureProperties> {
  readonly id: CollectionId
  readonly size: number

  get(id: FeatureId): BlaeuFeature<P> | undefined
  has(id: FeatureId): boolean
  all(): readonly BlaeuFeature<P>[]

  /** Spatially indexed. O(log n), not O(n) — this is on the `pointermove` path. */
  query(bbox: Bbox): readonly BlaeuFeature<P>[]
  nearest(point: LngLat, maxDistanceMetres?: number): BlaeuFeature<P> | undefined

  toGeoJSON(): GeoJsonFeatureCollection
  [Symbol.iterator](): Iterator<BlaeuFeature<P>>
}

/**
 * The index that makes topological editing possible.
 *
 * It maps a *quantised* coordinate — snapped to the working CRS's precision grid,
 * 1 mm for cadastre — to every vertex sitting on it. Two adjacent parcels sharing
 * a corner therefore resolve to one key with two {@link VertexRef}s, and moving
 * that corner moves both parcels in a single command.
 *
 * The quantisation is load-bearing. Exact float equality would treat corners
 * 10⁻¹² m apart as distinct, they'd drift apart under editing, and you would have
 * manufactured a sliver — which in a land registry is not a rendering artefact
 * but a legal problem.
 */
export interface TopologyIndex {
  /** Every vertex coincident with `point`, within the working CRS's tolerance. */
  at(point: LngLat): readonly VertexRef[]
  /** Every feature with a vertex coincident with `point`. */
  featuresAt(point: LngLat): readonly FeatureId[]
  /** True if more than one feature shares this vertex. */
  isShared(point: LngLat): boolean
  rebuild(): void
}

/**
 * The single source of truth for all geometry.
 *
 * **Never mutate what you get out of it** (core invariant 2). Reads return frozen
 * objects in development so the mistake fails loudly rather than silently
 * desyncing the renderer and breaking undo three actions later. All writes go
 * through the command bus.
 */
export interface FeatureStore {
  collection<P extends FeatureProperties = FeatureProperties>(id: CollectionId): Collection<P>
  collections(): readonly CollectionId[]
  createCollection(id: CollectionId): Collection
  removeCollection(id: CollectionId): void

  /** Look a feature up without knowing its collection. */
  find(id: FeatureId): BlaeuFeature | undefined

  readonly topology: TopologyIndex

  /**
   * A deep, structurally-shared snapshot of everything.
   *
   * This is what the undo round-trip test compares (`blaeu-testing`, test 3),
   * and what a collaboration plugin would diff to produce a patch.
   */
  snapshot(): StoreSnapshot

  restore(snapshot: StoreSnapshot): void

  onChange(handler: (change: StoreChange) => void): Disposable

  /**
   * The features an `_add` *would* produce — ids minted, meta stamped, geometry
   * normalised and quantised — without writing any of them.
   *
   * A `CommitCommand` uses this to tell the commit pipeline what is about to land,
   * so that middleware judges and rewrites the real thing rather than the raw input.
   * Pure: safe to call for a write that the pipeline then rejects.
   */
  materialise(collection: CollectionId, features: readonly FeatureInput[]): readonly BlaeuFeature[]

  /* --- Internal write path. Commands call these; application code does not. --- */
  /** @internal */
  _add(collection: CollectionId, features: readonly FeatureInput[]): readonly BlaeuFeature[]
  /**
   * @internal
   *
   * `options.rewindRings` (default `true`) controls whether polygon rings are wound
   * to RFC 7946 on the way in. A transient edit *preview* passes `false` so a drag's
   * positional vertex references are not invalidated mid-gesture by a silent ring
   * reversal; the durable commit leaves it `true`. See ADR 0011.
   */
  _update(
    features: readonly BlaeuFeature[],
    options?: { readonly rewindRings?: boolean },
  ): readonly BlaeuFeature[]
  /** @internal */
  _remove(ids: readonly FeatureId[]): readonly BlaeuFeature[]
}

export interface StoreSnapshot {
  readonly collections: Readonly<Record<CollectionId, readonly BlaeuFeature[]>>
  readonly revision: number
}

export interface StoreChange {
  readonly kind: 'add' | 'update' | 'remove'
  readonly collection: CollectionId
  readonly features: readonly BlaeuFeature[]
  readonly previous: readonly BlaeuFeature[]
}
