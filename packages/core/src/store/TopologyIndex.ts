import type { FeatureId, LngLat } from '../types/common.js'
import type { CrsService } from '../types/crs.js'
import type { BlaeuFeature, VertexRef } from '../types/feature.js'
import type { TopologyIndex } from '../types/store.js'
import { eachVertex, toLngLat } from '../utils/geometry.js'

interface Entry {
  readonly ref: VertexRef
  /** Projected position, in metres. Kept so lookups compare in the plane, never in degrees. */
  readonly x: number
  readonly y: number
}

/** A CRS that reports a precision of 0 would key every vertex into cell `Infinity`. */
const FALLBACK_GRID_METRES = 0.001

/**
 * The index that makes topological editing possible.
 *
 * Vertices are bucketed by their **quantised** position: the projected coordinate
 * divided by the working CRS's precision grid (1 mm for cadastre) and rounded to
 * an integer cell. Two parcels that share a corner land in one bucket with two
 * {@link VertexRef}s, so `moveVertex` on that corner moves both parcels in a
 * single command and the boundary between them cannot come apart.
 *
 * ### Why lookups probe the neighbouring cells too
 *
 * Rounding to a grid has a boundary: two corners 0.4 mm apart can straddle a cell
 * edge (0.3 mm and 0.7 mm past a grid line round *away* from each other) and land
 * in adjacent cells. Keying alone would call them different corners — and the
 * software would have manufactured a 0.4 mm sliver between two parcels that the
 * surveyor drew as touching. In a land registry that is not a rendering artefact;
 * it is a strip of land with no owner.
 *
 * So a lookup reads the 3×3 block of cells around the query point and keeps
 * everything within one grid cell of it (Chebyshev distance ≤ the grid). The
 * tolerance *is* the CRS's declared precision: at 1 mm, two corners closer than
 * that are the same corner, by definition, and any tool that claims to
 * distinguish them is lying about its accuracy.
 */
export class BlaeuTopologyIndex implements TopologyIndex {
  readonly #crs: CrsService
  readonly #source: () => Iterable<BlaeuFeature>

  #cells = new Map<string, Entry[]>()
  /** Cell keys touched by each feature, so de-indexing one parcel doesn't walk the whole map. */
  #byFeature = new Map<FeatureId, string[]>()

  constructor(crs: CrsService, source: () => Iterable<BlaeuFeature>) {
    this.#crs = crs
    this.#source = source
  }

  get #grid(): number {
    const precision = this.#crs.working.precision
    return precision > 0 ? precision : FALLBACK_GRID_METRES
  }

  at(point: LngLat): readonly VertexRef[] {
    const [x, y] = this.#crs.working.forward(point)
    const grid = this.#grid
    const cx = Math.round(x / grid)
    const cy = Math.round(y / grid)

    // A hair over one cell, because the numbers being compared are noisy: `entry.x`
    // and `x` are both `forward()`-ed from lng/lat that the store had itself
    // `inverse()`-ed from a grid point, so each carries a projection round-trip
    // error — and a projected coordinate is a *large* number, so even representing
    // it costs precision. A TM northing near Ankara is 4 400 km, where one ULP is
    // already a nanometre.
    //
    // The slack must therefore scale with the **magnitude of the coordinate**, not
    // with the grid. It is the boundary case that decides it, and that case is the
    // whole reason the 3×3 probe exists: two corners 0.4 mm apart quantise onto
    // *adjacent* cells, exactly one grid apart. In EPSG:5254 near Ankara they then
    // measure 1.000 000 28 mm apart — and a slack of one ten-millionth of the grid
    // (0.1 nm at 1 mm) misses them by 0.18 of a nanometre. The index would report
    // one parcel on a corner that two parcels share, the edit plugin would move only
    // one of them, and the sliver this whole class exists to prevent is created —
    // decided by a rounding error 5 000 times smaller than an atom.
    //
    // Capped at 1% of the grid so the tolerance can never drift into meaning
    // something geometrically different from "one cell".
    const noise = Math.max(Math.abs(x), Math.abs(y)) * 1e-11
    const tolerance = grid + Math.min(noise, grid * 0.01)

    const found: VertexRef[] = []
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const entries = this.#cells.get(`${cx + dx}:${cy + dy}`)
        if (entries === undefined) continue
        for (const entry of entries) {
          if (Math.abs(entry.x - x) <= tolerance && Math.abs(entry.y - y) <= tolerance) {
            found.push(entry.ref)
          }
        }
      }
    }
    return found
  }

  featuresAt(point: LngLat): readonly FeatureId[] {
    const ids = new Set<FeatureId>()
    for (const ref of this.at(point)) ids.add(ref.feature)
    return [...ids]
  }

  isShared(point: LngLat): boolean {
    return this.featuresAt(point).length > 1
  }

  /**
   * Re-key every vertex in the current working plane. Called when `setWorking` moves
   * the plane out from under the index.
   *
   * **Atomic and total.** It builds a *fresh* pair of maps and only swaps them in once
   * the whole dataset has been walked — so a feature that cannot project into the new
   * plane (a coordinate outside the CRS's usable extent) is skipped rather than
   * aborting the walk and leaving the index half-built. A half-built index is worse
   * than the stale-but-complete one it replaced: it reports shared corners as unshared
   * for every feature past the failure, silently. The previous index survives an
   * unexpected throw untouched.
   */
  rebuild(): void {
    const cells = new Map<string, Entry[]>()
    const byFeature = new Map<FeatureId, string[]>()

    for (const feature of this.#source()) {
      try {
        this.#indexInto(feature, cells, byFeature)
      } catch {
        // A feature whose vertices do not project finitely in this plane has no
        // position in it, so it cannot take part in topology here — leave it out of
        // the index rather than fail the whole rebuild. (`index()` on a live `_add`
        // still throws: a bad coordinate arriving one at a time is an error to surface.)
      }
    }

    this.#cells = cells
    this.#byFeature = byFeature
  }

  /** @internal Called by the store on `_add`. Throws (all-or-nothing) on a non-projectable vertex. */
  index(feature: BlaeuFeature): void {
    this.#indexInto(feature, this.#cells, this.#byFeature)
  }

  /**
   * Index one feature into the given maps, all-or-nothing.
   *
   * Every vertex is projected *first*, into a local list; only once they all succeed
   * are the buckets written. So a vertex that fails to project throws before anything
   * is mutated — no orphan entries in `cells` with no matching `byFeature` key that
   * `deindex` could never find and remove.
   */
  #indexInto(
    feature: BlaeuFeature,
    cells: Map<string, Entry[]>,
    byFeature: Map<FeatureId, string[]>,
  ): void {
    const grid = this.#grid
    const plane = this.#crs.working
    const pending: { key: string; entry: Entry }[] = []

    eachVertex(feature.geometry, (part, ring, index, position) => {
      const [x, y] = plane.forward(toLngLat(position))
      const key = `${Math.round(x / grid)}:${Math.round(y / grid)}`
      pending.push({ key, entry: { ref: { feature: feature.id, part, ring, index }, x, y } })
    })

    const keys: string[] = []
    for (const { key, entry } of pending) {
      let bucket = cells.get(key)
      if (bucket === undefined) {
        bucket = []
        cells.set(key, bucket)
      }
      bucket.push(entry)
      keys.push(key)
    }
    byFeature.set(feature.id, keys)
  }

  /** @internal Called by the store on `_remove`. */
  deindex(id: FeatureId): void {
    const keys = this.#byFeature.get(id)
    if (keys === undefined) return

    for (const key of new Set(keys)) {
      const bucket = this.#cells.get(key)
      if (bucket === undefined) continue
      const kept = bucket.filter((entry) => entry.ref.feature !== id)
      if (kept.length === 0) this.#cells.delete(key)
      else this.#cells.set(key, kept)
    }
    this.#byFeature.delete(id)
  }

  /**
   * @internal Called by the store on `_update`.
   *
   * Incremental, not a rebuild: a vertex drag updates the feature on every
   * `pointermove`, and rebuilding a 50 000-parcel index at pointer frequency is
   * the difference between editing and watching a spinner.
   */
  reindex(feature: BlaeuFeature): void {
    this.deindex(feature.id)
    this.index(feature)
  }

  /** @internal Teardown / `restore()`. */
  clear(): void {
    this.#cells = new Map()
    this.#byFeature = new Map()
  }
}
