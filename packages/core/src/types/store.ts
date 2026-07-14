import type { Bbox, CollectionId, Disposable, FeatureId, LngLat } from './common.js'
import type { FeatureInput, FeatureProperties, FlexiFeature, VertexRef } from './feature.js'
import type { FeatureCollection as GeoJsonFeatureCollection } from 'geojson'

/** A named set of features. Maps 1:1 to a renderer source, and is the unit of styling. */
export interface Collection<P extends FeatureProperties = FeatureProperties> {
  readonly id: CollectionId
  readonly size: number

  get(id: FeatureId): FlexiFeature<P> | undefined
  has(id: FeatureId): boolean
  all(): readonly FlexiFeature<P>[]

  /** Spatially indexed. O(log n), not O(n) — this is on the `pointermove` path. */
  query(bbox: Bbox): readonly FlexiFeature<P>[]
  nearest(point: LngLat, maxDistanceMetres?: number): FlexiFeature<P> | undefined

  toGeoJSON(): GeoJsonFeatureCollection
  [Symbol.iterator](): Iterator<FlexiFeature<P>>
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
  find(id: FeatureId): FlexiFeature | undefined

  readonly topology: TopologyIndex

  /**
   * A deep, structurally-shared snapshot of everything.
   *
   * This is what the undo round-trip test compares (`fleximap-testing`, test 3),
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
  materialise(collection: CollectionId, features: readonly FeatureInput[]): readonly FlexiFeature[]

  /* --- Internal write path. Commands call these; application code does not. --- */
  /** @internal */
  _add(collection: CollectionId, features: readonly FeatureInput[]): readonly FlexiFeature[]
  /** @internal */
  _update(features: readonly FlexiFeature[]): readonly FlexiFeature[]
  /** @internal */
  _remove(ids: readonly FeatureId[]): readonly FlexiFeature[]
}

export interface StoreSnapshot {
  readonly collections: Readonly<Record<CollectionId, readonly FlexiFeature[]>>
  readonly revision: number
}

export interface StoreChange {
  readonly kind: 'add' | 'update' | 'remove'
  readonly collection: CollectionId
  readonly features: readonly FlexiFeature[]
  readonly previous: readonly FlexiFeature[]
}
