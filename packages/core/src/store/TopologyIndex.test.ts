import { describe, expect, it } from 'vitest'
import type { Polygon, Position } from 'geojson'

import { BlaeuEventBus } from '../events/EventBus.js'
import { BlaeuFeatureStore } from './FeatureStore.js'
import { createTestCrs, offsetMetres } from './test-crs.js'
import type { CrsService } from '../types/crs.js'
import type { LngLat } from '../types/common.js'

const ANKARA: LngLat = [32.85, 39.93]

function setup() {
  const crs = createTestCrs() // 1 mm grid
  const store = new BlaeuFeatureStore(crs, new BlaeuEventBus(), { strict: true })
  return { crs, store }
}

/** A rectangle whose corners are given in projected metres relative to `origin`. */
function rect(crs: CrsService, origin: LngLat, x0: number, y0: number, x1: number, y1: number) {
  const corner = (dx: number, dy: number): Position => [...offsetMetres(crs, origin, dx, dy)]
  const geometry: Polygon = {
    type: 'Polygon',
    coordinates: [[corner(x0, y0), corner(x1, y0), corner(x1, y1), corner(x0, y1), corner(x0, y0)]],
  }
  return geometry
}

describe('BlaeuTopologyIndex', () => {
  it('resolves a corner shared by two parcels to one key with two vertex refs', () => {
    const { crs, store } = setup()
    // Two 20 m parcels meeting along x = 20 m. The corner at (20, 0) belongs to both.
    store._add('parcels', [
      { id: 'west', geometry: rect(crs, ANKARA, 0, 0, 20, 20) },
      { id: 'east', geometry: rect(crs, ANKARA, 20, 0, 40, 20) },
    ])

    const sharedCorner = offsetMetres(crs, ANKARA, 20, 0)
    const refs = store.topology.at(sharedCorner)

    expect(refs).toHaveLength(2)
    expect(new Set(refs.map((r) => r.feature))).toEqual(new Set(['west', 'east']))
    expect(store.topology.isShared(sharedCorner)).toBe(true)
    expect(new Set(store.topology.featuresAt(sharedCorner))).toEqual(new Set(['west', 'east']))
  })

  it('resolves two corners 0.4 mm apart as shared — the sliver case', () => {
    const { crs, store } = setup()

    // Straddle a grid cell edge on purpose. `onGrid` sits exactly on a 1 mm grid
    // point, so the west parcel's boundary at +20.0003 m is 0.3 mm past a grid line
    // and the east parcel's at +20.0007 m is 0.7 mm past it. They are 0.4 mm apart —
    // finer than the CRS can even express — yet they round *away from each other*,
    // into different cells. An index that keyed on the cell alone would call them two
    // corners and quietly open a 0.4 mm strip of unowned land between two parcels the
    // surveyor drew as touching. That is not a rendering artefact; it is a title
    // dispute.
    const onGrid = crs.quantise(ANKARA)
    store._add('parcels', [
      { id: 'west', geometry: rect(crs, onGrid, 0, 0, 20.0003, 20) },
      { id: 'east', geometry: rect(crs, onGrid, 20.0007, 0, 40, 20) },
    ])

    const corner = offsetMetres(crs, onGrid, 20, 0)
    const refs = store.topology.at(corner)

    expect(new Set(refs.map((r) => r.feature))).toEqual(new Set(['west', 'east']))
    expect(store.topology.isShared(corner)).toBe(true)

    // And prove quantisation did the work rather than luck: the two stored corners are
    // no more than one grid cell apart, and the 0.4 mm of noise is gone.
    const stored = (id: string, index: number): LngLat => {
      const ring = (store.find(id)!.geometry as Polygon).coordinates[0]!
      const p = ring[index]!
      return [p[0]!, p[1]!]
    }
    expect(crs.distance(stored('west', 1), stored('east', 0))).toBeLessThanOrEqual(0.0011)
  })

  it('resolves the sliver case *wherever* the parcels sit — not just at lucky coordinates', () => {
    const { crs, store } = setup()

    // The test above tests one throw of a coin, and the coin comes up heads at Ankara.
    //
    // The sliver case is a boundary case: two corners 0.4 mm apart quantise onto
    // *adjacent* 1 mm cells, so the separation `at()` has to measure is exactly one
    // grid. Whether that measurement comes back as 0.999 999 7 mm or 1.000 000 3 mm
    // is decided by float noise — the projected coordinates are ~10^6 m numbers that
    // have been through a projection round-trip, so they carry a few ULPs of error,
    // and an ULP at a TM northing of 4 400 km is a nanometre. A tolerance expressed
    // as a fraction of the *grid* (`grid * 1.0000001` — 0.1 nm at 1 mm) is an order
    // of magnitude smaller than that noise and so absorbs none of it.
    //
    // The consequence is not academic: at 50 m east of here the coin comes up tails,
    // `at()` reports one parcel on a corner that two parcels share, and a topological
    // drag moves one of them and leaves the other behind — a 7.8 m gap between two
    // parcels in a land registry. So walk the plane and demand it hold everywhere.
    const onGrid = crs.quantise(ANKARA)

    for (let i = 0; i < 40; i++) {
      // A fresh origin each time, so every pair is measured at a different projected
      // coordinate and the float error lands on a different side of the tolerance.
      const origin = crs.quantise(offsetMetres(crs, onGrid, i * 137, i * 91))
      store._add('parcels', [
        // 0.3 mm and 0.7 mm past the same grid line: 0.4 mm apart, adjacent cells.
        { id: `west-${i}`, geometry: rect(crs, origin, 0, 0, 20.0003, 20) },
        { id: `east-${i}`, geometry: rect(crs, origin, 20.0007, 0, 40, 20) },
      ])

      const corner = offsetMetres(crs, origin, 20, 0)
      expect(new Set(store.topology.featuresAt(corner))).toEqual(
        new Set([`west-${i}`, `east-${i}`]),
      )
      expect(store.topology.isShared(corner)).toBe(true)
    }
  })

  it('does not double-count a ring’s closing vertex as a second corner', () => {
    const { crs, store } = setup()
    store._add('parcels', [{ id: 'lonely', geometry: rect(crs, ANKARA, 0, 0, 20, 20) }])

    // The first corner is also the last coordinate of the closed ring. If the index
    // counted it twice, a parcel would appear to share a corner with itself and every
    // topological edit would try to move it twice.
    const corner = offsetMetres(crs, ANKARA, 0, 0)
    expect(store.topology.at(corner)).toHaveLength(1)
    expect(store.topology.isShared(corner)).toBe(false)
  })

  it('addresses the right vertex — part, ring, index', () => {
    const { crs, store } = setup()
    store._add('parcels', [{ id: 'p', geometry: rect(crs, ANKARA, 0, 0, 20, 20) }])

    const [ref] = store.topology.at(offsetMetres(crs, ANKARA, 20, 20))
    expect(ref).toEqual({ feature: 'p', part: 0, ring: 0, index: 2 })
  })

  it('indexes the vertices of holes too', () => {
    const { crs, store } = setup()
    const outer = rect(crs, ANKARA, 0, 0, 40, 40).coordinates[0]!
    const hole = rect(crs, ANKARA, 10, 10, 20, 20).coordinates[0]!
    store._add('parcels', [{ id: 'p', geometry: { type: 'Polygon', coordinates: [outer, hole] } }])

    const [ref] = store.topology.at(offsetMetres(crs, ANKARA, 10, 10))
    expect(ref?.ring).toBe(1)
  })

  it('follows the geometry: a moved corner is no longer shared', () => {
    const { crs, store } = setup()
    store._add('parcels', [
      { id: 'west', geometry: rect(crs, ANKARA, 0, 0, 20, 20) },
      { id: 'east', geometry: rect(crs, ANKARA, 20, 0, 40, 20) },
    ])
    const corner = offsetMetres(crs, ANKARA, 20, 0)
    expect(store.topology.isShared(corner)).toBe(true)

    // Drag the east parcel a metre east. Its corner leaves the shared cell.
    const east = store.find('east')!
    store._update([{ ...east, geometry: rect(crs, ANKARA, 21, 0, 41, 20) }])

    expect(store.topology.isShared(corner)).toBe(false)
    expect(store.topology.featuresAt(corner)).toEqual(['west'])
  })

  it('forgets a removed feature', () => {
    const { crs, store } = setup()
    store._add('parcels', [
      { id: 'west', geometry: rect(crs, ANKARA, 0, 0, 20, 20) },
      { id: 'east', geometry: rect(crs, ANKARA, 20, 0, 40, 20) },
    ])
    const corner = offsetMetres(crs, ANKARA, 20, 0)

    store._remove(['east'])

    expect(store.topology.at(corner).map((r) => r.feature)).toEqual(['west'])
    expect(store.topology.isShared(corner)).toBe(false)
  })

  it('rebuild() reproduces exactly what the incremental path built', () => {
    const { crs, store } = setup()
    store._add('parcels', [
      { id: 'west', geometry: rect(crs, ANKARA, 0, 0, 20, 20) },
      { id: 'east', geometry: rect(crs, ANKARA, 20, 0, 40, 20) },
    ])
    const corner = offsetMetres(crs, ANKARA, 20, 20)
    const incremental = store.topology.at(corner)

    store.topology.rebuild()

    expect(store.topology.at(corner)).toEqual(incremental)
  })

  it('reports nothing at an empty spot', () => {
    const { crs, store } = setup()
    store._add('parcels', [{ id: 'p', geometry: rect(crs, ANKARA, 0, 0, 20, 20) }])
    expect(store.topology.at(offsetMetres(crs, ANKARA, 500, 500))).toEqual([])
  })
})
