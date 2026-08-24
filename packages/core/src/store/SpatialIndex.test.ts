/**
 * The R-tree, tested directly.
 *
 * Everything else in the suite reaches the index through `BlaeuCollection`, and that
 * indirection hides it: `query()` looks up every id the index hands back in the feature
 * map and silently drops the ones that are not there, so an index that *over*-reports —
 * a stale entry left behind by a `remove()` that did nothing, a duplicate left behind by
 * an `update()` that only inserted — produces exactly the right answer through the
 * collection and exactly the wrong one the moment the feature is still in the store but
 * has moved. That is the failure this file exists to catch, and it is why these tests
 * talk to `SpatialIndex` rather than to the store.
 *
 * No CRS here, deliberately. The index never projects: `geometryBbox` reads raw
 * lng/lat, so exact decimal literals are honest inputs *and* exactly comparable, which
 * is what lets a probe pinned one hundredth of a degree outside an edge mean something.
 */
import { describe, expect, it } from 'vitest'
import type { Geometry, Polygon } from 'geojson'

import { SpatialIndex } from './SpatialIndex.js'
import type { Bbox, FeatureId } from '../types/common.js'
import type { BlaeuFeature } from '../types/feature.js'

/** A closed rectangle. The corners are the literals given, so its bbox is them, bit for bit. */
function rect(west: number, south: number, east: number, north: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  }
}

/**
 * The index reads exactly two fields — `id` and `geometry` — so the rest is the minimum
 * the type demands. Building these by hand rather than through the store keeps the test
 * honest about what the index actually depends on.
 */
function feature(id: FeatureId, geometry: Geometry): BlaeuFeature {
  return {
    id,
    geometry,
    properties: {},
    meta: { collection: 'parcels', version: 1, createdAt: 0, updatedAt: 0 },
  }
}

/*
 * Three disjoint parcels in a row east of Ankara, each 0.06° wide and 0.02° tall.
 *
 * Not square, and the x range (32.8–33.1) shares no interval with the y range
 * (39.9–39.92): any bbox slot that ends up in the wrong axis makes the entry's box
 * inverted or disjoint, and the pinpricks below stop hitting it.
 */
const A = rect(32.8, 39.9, 32.86, 39.92)
const B = rect(32.9, 39.9, 32.96, 39.92)
const C = rect(33.0, 39.9, 33.06, 39.92)

/** Zero-area probes — a pointer hit-test is a pinprick, not a window. */
const IN_A: Bbox = [32.83, 39.91, 32.83, 39.91]
const IN_B: Bbox = [32.93, 39.91, 32.93, 39.91]
const IN_C: Bbox = [33.03, 39.91, 33.03, 39.91]
/** Wide enough to contain all three parcels and then some. */
const EVERYTHING: Bbox = [32.0, 39.0, 34.0, 40.0]

describe('SpatialIndex — the bbox contract', () => {
  it('maps [west, south, east, north] onto minX/minY/maxX/maxY, in that order', () => {
    const index = new SpatialIndex()
    index.insert(feature('a', A))

    // Every corner and the centre must hit. A swapped pair inverts the box — minX > maxX
    // or minY > maxY — and rbush's intersection test then matches nothing at all.
    const inside: readonly Bbox[] = [
      [32.8, 39.9, 32.8, 39.9], // SW corner
      [32.86, 39.9, 32.86, 39.9], // SE corner
      [32.86, 39.92, 32.86, 39.92], // NE corner
      [32.8, 39.92, 32.8, 39.92], // NW corner
      [32.83, 39.91, 32.83, 39.91], // centre
    ]
    for (const probe of inside) expect(index.search(probe)).toEqual(['a'])

    // …and a pinprick just past each edge must miss. This half is what pins the box's
    // *extent*: without it, "something got indexed somewhere near Ankara" would pass.
    const outside: readonly Bbox[] = [
      [32.79, 39.91, 32.79, 39.91], // west of the west edge
      [32.87, 39.91, 32.87, 39.91], // east of the east edge
      [32.83, 39.89, 32.83, 39.89], // south of the south edge
      [32.83, 39.93, 32.83, 39.93], // north of the north edge
    ]
    for (const probe of outside) expect(index.search(probe)).toEqual([])
  })

  it('reads a query bbox as [west, south, east, north] too', () => {
    const index = new SpatialIndex()
    index.insert(feature('a', A))

    // A window that covers the parcel, wide in x and short in y — so the two axes cannot
    // be confused for one another.
    expect(index.search([32.7, 39.89, 32.95, 39.93])).toEqual(['a'])

    // Windows that clear the parcel on one side at a time. Under any slot swap at least
    // one of these flips from miss to hit.
    expect(index.search([32.6, 39.89, 32.79, 39.93])).toEqual([]) // entirely west
    expect(index.search([32.87, 39.89, 32.95, 39.93])).toEqual([]) // entirely east
    expect(index.search([32.7, 39.8, 32.95, 39.89])).toEqual([]) // entirely south
    expect(index.search([32.7, 39.93, 32.95, 39.99])).toEqual([]) // entirely north
  })

  it('answers with ids, and only for the boxes that actually overlap', () => {
    const index = new SpatialIndex()
    index.insert(feature('a', A))
    index.insert(feature('b', B))
    index.insert(feature('c', C))

    expect(index.search(IN_A)).toEqual(['a'])
    expect(index.search(IN_B)).toEqual(['b'])
    expect(index.search(IN_C)).toEqual(['c'])
    expect(index.search(EVERYTHING).sort()).toEqual(['a', 'b', 'c'])
    // A gap between two parcels is a gap.
    expect(index.search([32.88, 39.91, 32.88, 39.91])).toEqual([])
  })
})

describe('SpatialIndex — size', () => {
  it('counts the entries, through every write path', () => {
    const index = new SpatialIndex()
    expect(index.size).toBe(0)

    index.insert(feature('a', A))
    index.insert(feature('b', B))
    expect(index.size).toBe(2)

    // An update is one feature before and one after — never two.
    index.update(feature('a', C))
    expect(index.size).toBe(2)

    index.remove('a')
    expect(index.size).toBe(1)

    // Removing what is not there changes nothing.
    index.remove('never-existed')
    expect(index.size).toBe(1)

    index.clear()
    expect(index.size).toBe(0)
  })
})

describe('SpatialIndex — insert', () => {
  it('records the entry it put in the tree, so remove() can find it again', () => {
    const index = new SpatialIndex()
    index.insert(feature('a', A))

    // The entries map is not decoration: rbush removes by *reference*, so an entry the
    // tree holds but the map has forgotten can never be evicted again.
    expect(index.size).toBe(1)
    index.remove('a')
    expect(index.search(IN_A)).toEqual([])
  })
})

describe('SpatialIndex — remove', () => {
  it('takes the feature out of the tree and out of the entries map', () => {
    const index = new SpatialIndex()
    index.insert(feature('a', A))
    index.insert(feature('b', B))

    index.remove('a')

    expect(index.search(IN_A)).toEqual([])
    expect(index.search(EVERYTHING)).toEqual(['b'])
    expect(index.size).toBe(1)
  })

  it('is a no-op for an id it never held, and leaves the rest alone', () => {
    const index = new SpatialIndex()
    index.insert(feature('a', A))

    expect(() => index.remove('never-existed')).not.toThrow()

    expect(index.search(IN_A)).toEqual(['a'])
    expect(index.size).toBe(1)
  })

  it('is idempotent — removing twice does not evict a later feature with the same id', () => {
    const index = new SpatialIndex()
    index.insert(feature('a', A))
    index.remove('a')
    index.remove('a')

    index.insert(feature('a', C))
    expect(index.search(IN_C)).toEqual(['a'])
    expect(index.size).toBe(1)
  })
})

describe('SpatialIndex — update', () => {
  it('is remove-then-insert: the old box goes, the new box arrives, exactly once', () => {
    const index = new SpatialIndex()
    index.insert(feature('a', A))
    index.insert(feature('b', B))

    index.update(feature('a', C))

    expect(index.search(IN_A)).toEqual([]) // the old box is gone…
    expect(index.search(IN_C)).toEqual(['a']) // …the new one is there…
    expect(index.search(EVERYTHING).sort()).toEqual(['a', 'b']) // …and 'a' is in the tree once
    expect(index.size).toBe(2)
  })

  it('survives repeated moves — a tree that only ever grew would still answer the first two', () => {
    const index = new SpatialIndex()
    index.insert(feature('a', A))
    index.update(feature('a', B))
    index.update(feature('a', C))

    expect(index.search(IN_A)).toEqual([])
    expect(index.search(IN_B)).toEqual([])
    expect(index.search(IN_C)).toEqual(['a'])
    expect(index.search(EVERYTHING)).toEqual(['a'])
    expect(index.size).toBe(1)
  })

  it('inserts a feature it has never seen, rather than dropping it', () => {
    const index = new SpatialIndex()
    index.update(feature('a', A))

    expect(index.search(IN_A)).toEqual(['a'])
    expect(index.size).toBe(1)
  })
})

describe('SpatialIndex — load', () => {
  it('rebuilds the tree from scratch, dropping whatever was there before', () => {
    const index = new SpatialIndex()
    index.insert(feature('old', A))

    index.load([feature('a', B), feature('b', C)])

    expect(index.size).toBe(2)
    expect(index.search(IN_A)).toEqual([]) // 'old' did not survive the load
    expect(index.search(IN_B)).toEqual(['a'])
    expect(index.search(IN_C)).toEqual(['b'])
    expect(index.search(EVERYTHING).sort()).toEqual(['a', 'b'])
  })

  it('rekeys the entries map, so a bulk-loaded feature can still be removed and moved', () => {
    const index = new SpatialIndex()
    index.load([feature('a', A), feature('b', B)])

    // Both of these go through `#entries`; a load that filled the tree but not the map
    // would leave them silently inert.
    index.remove('a')
    index.update(feature('b', C))

    expect(index.search(IN_A)).toEqual([])
    expect(index.search(IN_B)).toEqual([])
    expect(index.search(IN_C)).toEqual(['b'])
    expect(index.size).toBe(1)
  })

  it('forgets the ids it held before, so a stale id cannot evict a fresh entry', () => {
    const index = new SpatialIndex()
    index.insert(feature('old', A))

    index.load([feature('a', B)])
    index.remove('old')

    expect(index.search(IN_B)).toEqual(['a'])
    expect(index.size).toBe(1)
  })

  it('loads nothing from nothing, and stays usable afterwards', () => {
    const index = new SpatialIndex()
    index.insert(feature('a', A))

    index.load([])

    expect(index.size).toBe(0)
    expect(index.search(EVERYTHING)).toEqual([])

    index.insert(feature('b', B))
    expect(index.search(IN_B)).toEqual(['b'])
  })

  it('takes any iterable, not just the array the store happens to hand it', () => {
    const index = new SpatialIndex()
    const byId = new Map([
      ['a', feature('a', A)],
      ['b', feature('b', B)],
    ])

    index.load(byId.values())

    expect(index.size).toBe(2)
    expect(index.search(EVERYTHING).sort()).toEqual(['a', 'b'])
  })
})

describe('SpatialIndex — clear', () => {
  it('empties the tree and the entries map, not one of the two', () => {
    const index = new SpatialIndex()
    index.insert(feature('a', A))
    index.insert(feature('b', B))

    index.clear()

    // The tree half.
    expect(index.search(EVERYTHING)).toEqual([])
    // The entries half — invisible to `search()`, which is exactly why it needs saying.
    expect(index.size).toBe(0)
  })

  it('leaves an index that still works', () => {
    const index = new SpatialIndex()
    index.insert(feature('a', A))
    index.clear()

    index.insert(feature('a', C))
    expect(index.search(IN_C)).toEqual(['a'])
    expect(index.search(IN_A)).toEqual([])
    expect(index.size).toBe(1)
  })
})
