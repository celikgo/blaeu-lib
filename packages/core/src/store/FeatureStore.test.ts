import { describe, expect, it, vi } from 'vitest'
import type { Polygon, Position } from 'geojson'

import { FlexiEventBus } from '../events/EventBus.js'
import { FlexiFeatureStore } from './FeatureStore.js'
import { createTestCrs, offsetMetres } from './test-crs.js'
import { ringSignedArea2 } from '../utils/geometry.js'
import type { CrsService } from '../types/crs.js'
import type { LngLat } from '../types/common.js'
import type { FlexiFeature } from '../types/feature.js'
import type { StoreChange } from '../types/store.js'

/** Ankara. Far enough from TM30's central meridian to catch a projection that isn't really projecting. */
const ANKARA: LngLat = [32.85, 39.93]

function setup(strict = true) {
  const crs = createTestCrs()
  const events = new FlexiEventBus()
  const store = new FlexiFeatureStore(crs, events, { strict })
  return { crs, events, store }
}

/**
 * An axis-aligned rectangle built in *projected metres*, so "a 20 m parcel" means
 * 20 metres and not 20 degrees. Wound counter-clockwise in the plane.
 */
function rect(crs: CrsService, origin: LngLat, width: number, height: number): Polygon {
  const corner = (dx: number, dy: number): Position => [...offsetMetres(crs, origin, dx, dy)]
  return {
    type: 'Polygon',
    coordinates: [
      [corner(0, 0), corner(width, 0), corner(width, height), corner(0, height), corner(0, 0)],
    ],
  }
}

describe('FlexiFeatureStore — collections', () => {
  it('auto-creates a collection on first access, so plugins need no defensive dance', () => {
    const { store } = setup()
    expect(store.collection('parcels').size).toBe(0)
    expect(store.collections()).toEqual(['parcels'])
  })

  it('createCollection is idempotent — a preset and a plugin may both declare one', () => {
    const { crs, store } = setup()
    const first = store.createCollection('parcels')
    store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])
    const second = store.createCollection('parcels')
    expect(second).toBe(first)
    expect(second.size).toBe(1)
  })

  it('removeCollection drops the features and tells the renderer they went', () => {
    const { crs, store, events } = setup()
    const removed = vi.fn()
    events.on('feature:removed', removed)
    const [feature] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])

    store.removeCollection('parcels')

    expect(store.collections()).toEqual([])
    expect(store.find(feature!.id)).toBeUndefined()
    expect(removed).toHaveBeenCalledOnce()
  })
})

describe('FlexiFeatureStore — ingest', () => {
  it('mints an id and stamps the meta', () => {
    const { crs, store } = setup()
    const before = Date.now()
    const [feature] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])

    expect(feature!.id).toMatch(/^f_/)
    expect(feature!.meta.collection).toBe('parcels')
    expect(feature!.meta.version).toBe(1)
    expect(feature!.meta.createdAt).toBeGreaterThanOrEqual(before)
    expect(feature!.meta.updatedAt).toBe(feature!.meta.createdAt)
  })

  it('honours a caller-supplied id and meta verbatim — the import and undo-of-remove path', () => {
    const { crs, store } = setup()
    const [feature] = store._add('parcels', [
      {
        id: 'parcel-000123',
        geometry: rect(crs, ANKARA, 10, 10),
        meta: {
          collection: 'parcels',
          version: 7,
          createdAt: 1000,
          updatedAt: 2000,
          source: 'tkgm',
        },
      },
    ])

    expect(feature!.id).toBe('parcel-000123')
    expect(feature!.meta).toMatchObject({
      version: 7,
      createdAt: 1000,
      updatedAt: 2000,
      source: 'tkgm',
    })
  })

  it('rejects a duplicate id, actionably', () => {
    const { crs, store } = setup()
    store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA, 10, 10) }])
    expect(() => store._add('buildings', [{ id: 'a', geometry: rect(crs, ANKARA, 5, 5) }])).toThrow(
      /already in "parcels"/,
    )
  })

  it('quantises every coordinate to the working CRS grid, once, on the way in', () => {
    const { crs, store } = setup()
    // A corner half a millimetre off the grid: exactly the sub-millimetre noise a
    // digitiser or a WFS round-trip produces.
    const noisy = offsetMetres(crs, ANKARA, 0.0004, 0.0003)
    const geometry: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [...noisy],
          [...offsetMetres(crs, ANKARA, 10, 0)],
          [...offsetMetres(crs, ANKARA, 10, 10)],
          [...offsetMetres(crs, ANKARA, 0, 10)],
          [...noisy],
        ],
      ],
    }

    const [feature] = store._add('parcels', [{ geometry }])
    const ring = (feature!.geometry as Polygon).coordinates[0]!

    for (const position of ring) {
      const quantised = crs.quantise([position[0]!, position[1]!])
      expect(position[0]).toBe(quantised[0])
      expect(position[1]).toBe(quantised[1])
    }
  })

  it('winds the exterior ring counter-clockwise, whatever came in (RFC 7946)', () => {
    const { crs, store } = setup()
    const clockwise = rect(crs, ANKARA, 10, 10)
    clockwise.coordinates[0]!.reverse()

    const [feature] = store._add('parcels', [{ geometry: clockwise }])
    expect(ringSignedArea2((feature!.geometry as Polygon).coordinates[0]!)).toBeGreaterThan(0)
  })

  it('winds holes clockwise, so a hole cannot silently become a second exterior ring', () => {
    const { crs, store } = setup()
    const outer = rect(crs, ANKARA, 40, 40).coordinates[0]!
    const hole = rect(crs, offsetMetres(crs, ANKARA, 10, 10), 10, 10).coordinates[0]!

    const [feature] = store._add('parcels', [
      { geometry: { type: 'Polygon', coordinates: [outer, hole] } },
    ])
    const rings = (feature!.geometry as Polygon).coordinates
    expect(ringSignedArea2(rings[0]!)).toBeGreaterThan(0)
    expect(ringSignedArea2(rings[1]!)).toBeLessThan(0)
  })

  it('closes an open ring and drops duplicate consecutive vertices', () => {
    const { crs, store } = setup()
    const a = [...offsetMetres(crs, ANKARA, 0, 0)]
    const b = [...offsetMetres(crs, ANKARA, 10, 0)]
    const c = [...offsetMetres(crs, ANKARA, 10, 10)]

    const [feature] = store._add('parcels', [
      { geometry: { type: 'Polygon', coordinates: [[a, a, b, b, c]] } },
    ])
    const ring = (feature!.geometry as Polygon).coordinates[0]!

    expect(ring).toHaveLength(4)
    expect(ring[0]).toEqual(ring[3])
  })

  it('refuses a NaN coordinate rather than painting nothing where a parcel should be', () => {
    const { store } = setup()
    expect(() =>
      store._add('parcels', [{ geometry: { type: 'Point', coordinates: [NaN, 39.93] } }]),
    ).toThrow(/finite \[lng, lat\]/)
  })
})

describe('FlexiFeatureStore — strict mode', () => {
  it('freezes what it hands out, so a mutating read fails loudly at the line that did it', () => {
    const { crs, store } = setup(true)
    const [added] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])
    const feature = store.collection('parcels').get(added!.id)!

    expect(Object.isFrozen(feature)).toBe(true)
    expect(Object.isFrozen(feature.geometry)).toBe(true)
    expect(Object.isFrozen(feature.meta)).toBe(true)
    expect(() => {
      ;(feature.geometry as Polygon).coordinates[0]![0]![0] = 0
    }).toThrow(TypeError)
  })

  it('leaves features writable when strict is off (the production build)', () => {
    const { crs, store } = setup(false)
    const [added] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])
    expect(Object.isFrozen(store.collection('parcels').get(added!.id)!)).toBe(false)
  })
})

describe('FlexiFeatureStore — spatial queries', () => {
  it('query(bbox) returns only what the box touches', () => {
    const { crs, store } = setup()
    const [here] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])
    store._add('parcels', [{ geometry: rect(crs, offsetMetres(crs, ANKARA, 5000, 5000), 10, 10) }])

    const near = offsetMetres(crs, ANKARA, 5, 5)
    const box = [near[0] - 0.001, near[1] - 0.001, near[0] + 0.001, near[1] + 0.001] as const

    const hits = store.collection('parcels').query(box)
    expect(hits.map((f) => f.id)).toEqual([here!.id])
  })

  it('finds the right feature among 2 000 without scanning them', () => {
    const { crs, store } = setup(false)
    const inputs = []
    for (let i = 0; i < 2000; i++) {
      inputs.push({ geometry: rect(crs, offsetMetres(crs, ANKARA, i * 50, 0), 20, 20) })
    }
    store._add('parcels', inputs)

    const target = offsetMetres(crs, ANKARA, 1500 * 50 + 10, 10)
    const found = store.collection('parcels').nearest(target)

    expect(found).toBeDefined()
    expect(found!.id).toBe(store.collection('parcels').all()[1500]!.id)
  })

  it('nearest() measures to the geometry in metres, and a point inside is at distance 0', () => {
    const { crs, store } = setup()
    const [parcel] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 20, 20) }])
    const inside = offsetMetres(crs, ANKARA, 10, 10)

    expect(store.collection('parcels').nearest(inside)!.id).toBe(parcel!.id)
  })

  it('nearest() honours maxDistanceMetres — this is what a snap tolerance rides on', () => {
    const { crs, store } = setup()
    store._add('parcels', [{ geometry: rect(crs, ANKARA, 20, 20) }])
    const outside = offsetMetres(crs, ANKARA, -5, 10) // 5 m west of the western edge

    const collection = store.collection('parcels')
    expect(collection.nearest(outside, 1)).toBeUndefined()
    expect(collection.nearest(outside, 6)).toBeDefined()
  })

  it('reindexes on update, so a moved parcel is no longer found where it was', () => {
    const { crs, store } = setup()
    const [parcel] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 20, 20) }])
    const away = offsetMetres(crs, ANKARA, 10_000, 0)

    store._update([{ ...parcel!, geometry: rect(crs, away, 20, 20) }])

    const collection = store.collection('parcels')
    expect(collection.nearest(ANKARA, 100)).toBeUndefined()
    expect(collection.nearest(offsetMetres(crs, away, 10, 10))!.id).toBe(parcel!.id)
  })
})

describe('FlexiFeatureStore — the write path', () => {
  it('emits onChange before the bus event, so the renderer is in sync when plugins look', () => {
    const { crs, store, events } = setup()
    const order: string[] = []
    store.onChange((change: StoreChange) => order.push(`change:${change.kind}`))
    events.on('feature:added', () => order.push('event:added'))

    store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])
    expect(order).toEqual(['change:add', 'event:added'])
  })

  it('bumps version and updatedAt on a genuine edit, and reports the previous state', () => {
    const { crs, store, events } = setup()
    const [parcel] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])
    const updated = vi.fn()
    events.on('feature:updated', updated)

    const [next] = store._update([{ ...parcel!, properties: { ada: '42' } }])

    expect(next!.meta.version).toBe(2)
    expect(next!.properties['ada']).toBe('42')
    expect(updated).toHaveBeenCalledOnce()
    const payload = updated.mock.calls[0]![0].payload as {
      features: FlexiFeature[]
      previous: FlexiFeature[]
    }
    expect(payload.previous[0]!.meta.version).toBe(1)
  })

  it('takes the meta verbatim when the caller hands back a version we do not hold (undo, sync)', () => {
    const { crs, store } = setup()
    const [parcel] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])
    store._update([{ ...parcel!, properties: { ada: '42' } }]) // → version 2

    // The undo path: hand back the original, version 1.
    const [restored] = store._update([parcel!])

    expect(restored).toEqual(parcel)
  })

  it('refuses to update a feature it has never seen', () => {
    const { crs, store } = setup()
    const [parcel] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])
    expect(() => store._update([{ ...parcel!, id: 'ghost' }])).toThrow(/not in the store/)
  })

  it('_remove returns exactly what went, and skips ids that were already gone', () => {
    const { crs, store } = setup()
    const [parcel] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])

    const removed = store._remove([parcel!.id, 'never-existed'])

    expect(removed).toHaveLength(1)
    expect(removed[0]!.id).toBe(parcel!.id)
    expect(store.find(parcel!.id)).toBeUndefined()
    expect(store._remove([parcel!.id])).toHaveLength(0)
  })

  it('find() works across collections', () => {
    const { crs, store } = setup()
    const [parcel] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])
    const [building] = store._add('buildings', [{ geometry: rect(crs, ANKARA, 4, 4) }])

    expect(store.find(parcel!.id)!.meta.collection).toBe('parcels')
    expect(store.find(building!.id)!.meta.collection).toBe('buildings')
  })
})

describe('FlexiFeatureStore — snapshot and restore', () => {
  it('round-trips to deep equality, which is the whole basis of undo', () => {
    const { crs, store } = setup()
    store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])
    const before = store.snapshot()

    const [added] = store._add('parcels', [
      { geometry: rect(crs, offsetMetres(crs, ANKARA, 30, 0), 10, 10) },
    ])
    store._update([{ ...added!, properties: { ada: '7' } }])
    expect(store.snapshot()).not.toEqual(before)

    store.restore(before)
    expect(store.snapshot()).toEqual(before)
  })

  it('is insensitive to insertion order — remove-then-re-add must compare equal', () => {
    const { crs, store } = setup()
    const [a] = store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA, 10, 10) }])
    store._add('parcels', [
      { id: 'b', geometry: rect(crs, offsetMetres(crs, ANKARA, 30, 0), 10, 10) },
    ])
    const before = store.snapshot()

    store._remove(['a'])
    store._add('parcels', [a!]) // back, but now last in insertion order

    expect(store.snapshot()).toEqual(before)
  })

  it('restore() announces what moved, so a rolled-back transaction repaints', () => {
    const { crs, store, events } = setup()
    const before = store.snapshot()
    const removed = vi.fn()
    events.on('feature:removed', removed)

    store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])
    store.restore(before)

    expect(removed).toHaveBeenCalledOnce()
    expect(store.collection('parcels').size).toBe(0)
  })

  it('rebuilds the topology index on restore', () => {
    const { crs, store } = setup()
    const before = store.snapshot()
    store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10) }])
    expect(store.topology.featuresAt(ANKARA)).toHaveLength(1)

    store.restore(before)
    expect(store.topology.featuresAt(ANKARA)).toHaveLength(0)
  })

  it('gives equal content an equal revision, and changed content a different one', () => {
    const { crs, store } = setup()
    store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA, 10, 10) }])
    const before = store.snapshot()

    store._remove(['a'])
    expect(store.snapshot().revision).not.toBe(before.revision)

    store.restore(before)
    expect(store.snapshot().revision).toBe(before.revision)
  })
})

describe('FlexiCollection — GeoJSON', () => {
  it('exports a detached FeatureCollection and keeps our bookkeeping out of it', () => {
    const { crs, store } = setup()
    store._add('parcels', [{ geometry: rect(crs, ANKARA, 10, 10), properties: { ada: '42' } }])

    const geojson = store.collection('parcels').toGeoJSON()
    const feature = geojson.features[0]!

    expect(geojson.type).toBe('FeatureCollection')
    expect(feature.properties).toEqual({ ada: '42' })
    expect(feature.properties).not.toHaveProperty('version')
    expect(feature).not.toHaveProperty('meta')

    // Detached: exports get mutated by whoever receives them.
    ;(feature.geometry as Polygon).coordinates[0]!.push([0, 0])
    expect((store.collection('parcels').all()[0]!.geometry as Polygon).coordinates[0]).toHaveLength(
      5,
    )
  })

  it('iterates its features', () => {
    const { crs, store } = setup()
    store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA, 10, 10) }])
    store._add('parcels', [
      { id: 'b', geometry: rect(crs, offsetMetres(crs, ANKARA, 30, 0), 10, 10) },
    ])

    expect([...store.collection('parcels')].map((f) => f.id)).toEqual(['a', 'b'])
  })
})
