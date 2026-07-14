import RBush from 'rbush'

import type { Bbox, FeatureId } from '../types/common.js'
import type { FlexiFeature } from '../types/feature.js'
import { geometryBbox } from '../utils/geometry.js'

interface Entry {
  minX: number
  minY: number
  maxX: number
  maxY: number
  readonly id: FeatureId
}

/**
 * The R-tree behind `collection.query()` and `collection.nearest()`.
 *
 * It exists for one reason: those two methods run on `pointermove`, up to 120
 * times a second, and a linear scan of a 50 000-parcel collection at that rate is
 * six million geometry tests per second. The map does not become "a bit sluggish"
 * — it stops responding to the pointer entirely, and the bug is reported as
 * "snapping is broken."
 *
 * Only bounding boxes live in the tree. It answers *which features are worth
 * looking at*; exact geometry tests are the caller's job, on the handful that
 * come back.
 */
export class SpatialIndex {
  #tree = new RBush<Entry>()
  /** Keeps the exact entry object we inserted, because rbush removes by reference. */
  #entries = new Map<FeatureId, Entry>()

  get size(): number {
    return this.#entries.size
  }

  insert(feature: FlexiFeature): void {
    const entry = toEntry(feature)
    this.#tree.insert(entry)
    this.#entries.set(feature.id, entry)
  }

  /**
   * Rebuilds the tree from scratch.
   *
   * rbush's bulk load builds a far better-balanced tree than the same items
   * inserted one at a time (and ~10× faster), so importing a cadastral sheet or
   * restoring a snapshot goes through here rather than through `insert()` in a
   * loop.
   */
  load(features: Iterable<FlexiFeature>): void {
    const entries = [...features].map(toEntry)
    this.#tree = new RBush<Entry>()
    this.#entries = new Map(entries.map((e) => [e.id, e]))
    this.#tree.load(entries)
  }

  remove(id: FeatureId): void {
    const entry = this.#entries.get(id)
    if (entry === undefined) return
    this.#tree.remove(entry)
    this.#entries.delete(id)
  }

  /** Remove-then-insert. An in-place bbox edit would corrupt the tree's internal bounds. */
  update(feature: FlexiFeature): void {
    this.remove(feature.id)
    this.insert(feature)
  }

  /** Ids whose *bounding box* intersects `bbox`. A superset of a true intersection test. */
  search(bbox: Bbox): FeatureId[] {
    const hits = this.#tree.search({
      minX: bbox[0],
      minY: bbox[1],
      maxX: bbox[2],
      maxY: bbox[3],
    })
    return hits.map((e) => e.id)
  }

  clear(): void {
    this.#tree.clear()
    this.#entries.clear()
  }
}

function toEntry(feature: FlexiFeature): Entry {
  const [west, south, east, north] = geometryBbox(feature.geometry)
  return { minX: west, minY: south, maxX: east, maxY: north, id: feature.id }
}
