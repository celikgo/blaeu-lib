/**
 * Benchmarks for the store's hot paths.
 *
 * The repository asserts performance in prose and verifies it nowhere. `store.ts:14` says
 * "O(log n), not O(n) — this is on the `pointermove` path"; `FeatureStore.ts:92` says the
 * search "keeps the pointer path logarithmic in a 50 000-parcel collection". Both are almost
 * certainly true — rbush is an R-tree — but "almost certainly true" is what the whole audit was
 * about, and a claim about a 50 000-parcel collection that nobody has ever run on 50 000
 * parcels is a claim, not a measurement.
 *
 * These are not a pass/fail gate. A wall-clock threshold in CI is a flake generator: shared
 * runners vary by more than the regressions worth catching. What they give you is a **shape**.
 * Run `npm run bench` before and after a change to an index, and read the ratio between the
 * sizes rather than the absolute numbers:
 *
 * - `query` and `nearest` should grow roughly **logarithmically**. 100× the features should
 *   cost a small multiple, not 100×. A linear ratio means the index is being bypassed —
 *   which is exactly the regression the prose promises cannot happen.
 * - `_add` of one feature into an existing store should be flat.
 * - `restore` is bulk-load, so it is linear by construction and only the constant matters.
 */
import { bench, describe } from 'vitest'

import { BlaeuEventBus } from '../events/EventBus.js'
import { BlaeuFeatureStore } from './FeatureStore.js'
import { createTestCrs, offsetMetres } from './test-crs.js'
import type { CrsService } from '../types/crs.js'
import type { LngLat } from '../types/common.js'
import type { FeatureInput } from '../types/feature.js'
import type { Polygon, Position } from 'geojson'

const ANKARA: LngLat = [32.85, 39.93]

/** The sizes that matter: a village, a district, and the stated bulk-import workload. */
const SIZES = [1_000, 10_000, 100_000] as const

function rect(crs: CrsService, origin: LngLat, size: number): Polygon {
  const at = (dx: number, dy: number): Position => [...offsetMetres(crs, origin, dx, dy)]
  return {
    type: 'Polygon',
    coordinates: [[at(0, 0), at(size, 0), at(size, size), at(0, size), at(0, 0)]],
  }
}

/**
 * A square grid of parcels, laid out in the working plane.
 *
 * Deliberately a grid rather than random scatter: a real cadastral sheet is a tiling, and a
 * uniform random cloud gives an R-tree an easier time than adjacency does.
 */
function grid(crs: CrsService, count: number): FeatureInput[] {
  const side = Math.ceil(Math.sqrt(count))
  const step = 30
  const out: FeatureInput[] = []
  for (let i = 0; i < count; i++) {
    const origin = offsetMetres(crs, ANKARA, (i % side) * step, Math.floor(i / side) * step)
    out.push({ id: `p${i}`, geometry: rect(crs, origin, 25), properties: {} })
  }
  return out
}

function seeded(count: number) {
  const crs = createTestCrs()
  const store = new BlaeuFeatureStore(crs, new BlaeuEventBus(), { strict: false })
  store._add('parcels', grid(crs, count))
  return { crs, store }
}

/* ------------------------------------------------------------------ *
 * The pointer path — the one the prose makes claims about
 * ------------------------------------------------------------------ */

for (const size of SIZES) {
  describe(`collection.query — ${size.toLocaleString('en')} parcels`, () => {
    const { crs, store } = seeded(size)
    const collection = store.collection('parcels')
    // A small window near the middle of the sheet, the size a pointer hit-test uses.
    const centre = offsetMetres(crs, ANKARA, 30 * Math.sqrt(size) * 0.5, 30 * Math.sqrt(size) * 0.5)
    const box: [number, number, number, number] = [
      centre[0] - 0.0005,
      centre[1] - 0.0005,
      centre[0] + 0.0005,
      centre[1] + 0.0005,
    ]

    bench('query a pointer-sized box', () => {
      collection.query(box)
    })
  })

  describe(`collection.nearest — ${size.toLocaleString('en')} parcels`, () => {
    const { crs, store } = seeded(size)
    const collection = store.collection('parcels')
    const at = offsetMetres(crs, ANKARA, 30 * Math.sqrt(size) * 0.5, 30 * Math.sqrt(size) * 0.5)

    bench('nearest, unbounded', () => {
      collection.nearest(at)
    })
  })
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

for (const size of SIZES) {
  describe(`writes into a ${size.toLocaleString('en')}-parcel store`, () => {
    const { crs, store } = seeded(size)
    let n = 0

    bench('add one feature', () => {
      store._add('parcels', [
        { id: `extra-${n++}`, geometry: rect(crs, offsetMetres(crs, ANKARA, -500, -500), 20) },
      ])
    })

    const snapshot = store.snapshot()
    bench('restore a full snapshot (the transaction rollback path)', () => {
      store.restore(snapshot)
    })
  })
}

/* ------------------------------------------------------------------ *
 * Bulk import — the stated 100k workload
 * ------------------------------------------------------------------ */

describe('bulk import', () => {
  const crs = createTestCrs()
  const batch = grid(crs, 10_000)

  bench('_add 10 000 parcels into an empty store', () => {
    const store = new BlaeuFeatureStore(crs, new BlaeuEventBus(), { strict: false })
    store._add('parcels', batch)
  })
})
