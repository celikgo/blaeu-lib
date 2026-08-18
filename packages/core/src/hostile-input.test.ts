/**
 * What the store does with garbage.
 *
 * A cadastral kernel ingests third-party GeoJSON, so "malformed input" is the normal case, not
 * the adversarial one. Every test here was red before the ingest-gate work and is green after;
 * several of them assert on the *store after the failure* rather than on the failure itself,
 * because the defect this suite exists for was never "the call succeeded" — it was "the call
 * correctly reported failure, and corrupted the store on its way out".
 */

import { describe, expect, it } from 'vitest'
import type { Polygon, Position } from 'geojson'

import { BlaeuEventBus } from './events/EventBus.js'
import { BlaeuFeatureStore } from './store/FeatureStore.js'
import { createTestCrs, offsetMetres } from './store/test-crs.js'
import { SetPropertiesCommand } from './commands/builtins.js'
import {
  EMPTY_RING,
  LOWERCASE_TYPE,
  MISSING_GEOMETRY,
  NON_FINITE,
  NULL_GEOMETRY,
  TWO_POINT_RING,
  UNKNOWN_TYPE,
} from './testing/hostile.js'
import type { CrsService } from './types/crs.js'
import type { LngLat } from './types/common.js'
import type { BlaeuFeature } from './types/feature.js'
import type { StoreSnapshot } from './types/store.js'

const ANKARA: LngLat = [32.85, 39.93]

function setup() {
  const crs = createTestCrs()
  const events = new BlaeuEventBus()
  const store = new BlaeuFeatureStore(crs, events, { strict: true })
  return { crs, events, store }
}

function rect(crs: CrsService, origin: LngLat, width: number, height: number): Polygon {
  const corner = (dx: number, dy: number): Position => [...offsetMetres(crs, origin, dx, dy)]
  return {
    type: 'Polygon',
    coordinates: [
      [corner(0, 0), corner(width, 0), corner(width, height), corner(0, height), corner(0, 0)],
    ],
  }
}

describe('the ingest gate is total', () => {
  const rejected: readonly [string, unknown][] = [
    ['an unknown geometry type', UNKNOWN_TYPE],
    ['a lower-cased type name', LOWERCASE_TYPE],
    ['a null geometry', NULL_GEOMETRY],
    ['a missing geometry', MISSING_GEOMETRY],
    ['a ring of two distinct corners', TWO_POINT_RING],
    ['a non-finite ordinate', NON_FINITE],
    ['an empty ring', EMPTY_RING],
  ]

  for (const [label, geometry] of rejected) {
    it(`rejects ${label} at the gate, with a [blaeu] message`, () => {
      const { store } = setup()
      expect(() => store._add('parcels', [{ geometry: geometry as never }])).toThrow(/^\[blaeu\]/)
    })

    it(`leaves the store untouched after rejecting ${label}`, () => {
      const { crs, store } = setup()
      const [good] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 20, 20) }])
      const before = store.snapshot()

      expect(() => store._add('parcels', [{ geometry: geometry as never }])).toThrow()

      // The whole point: not merely that it threw, but that nothing moved on the way out.
      expect(store.snapshot()).toEqual(before)
      expect(store.collection('parcels').size).toBe(1)
      expect(store.find(good!.id)).toBeDefined()
    })
  }

  /**
   * The load-bearing one. Before the `default:` arm, `normaliseGeometry` fell off the end of
   * its switch and returned `undefined` while still typed `Geometry` — so the *update* was
   * written, and the previously-good parcel ended up holding `geometry: undefined`: absent
   * from the spatial index, still counted by `collection.size`, and exported as a Feature with
   * no geometry member.
   */
  it('an unknown type in an update does not overwrite the good geometry already stored', () => {
    const { crs, store } = setup()
    const [parcel] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 20, 20) }])
    const original = parcel!.geometry

    expect(() => store._update([{ ...parcel!, geometry: UNKNOWN_TYPE } as BlaeuFeature])).toThrow(
      /^\[blaeu\]/,
    )

    const after = store.find(parcel!.id)
    expect(after?.geometry).toEqual(original)
    // Still indexed — the failure mode was a feature that `size` counts but `query` cannot find.
    expect(store.collection('parcels').query([32.0, 39.0, 33.0, 40.0])).toHaveLength(1)
    expect(store.collection('parcels').toGeoJSON().features[0]?.geometry).toEqual(original)
  })

  it('a mid-batch bad geometry writes none of the batch', () => {
    const { crs, store } = setup()
    const before = store.snapshot()

    expect(() =>
      store._add('parcels', [
        { geometry: rect(crs, ANKARA, 10, 10) },
        { geometry: rect(crs, offsetMetres(crs, ANKARA, 50, 0), 10, 10) },
        { geometry: UNKNOWN_TYPE as never },
      ]),
    ).toThrow()

    expect(store.snapshot()).toEqual(before)
    expect(store.collection('parcels').size).toBe(0)
  })

  it('names the offending type, so the importer knows what to convert', () => {
    const { store } = setup()
    expect(() => store._add('parcels', [{ geometry: UNKNOWN_TYPE as never }])).toThrow(/Circle/)
  })
})

describe('restore() is all-or-nothing', () => {
  /**
   * `restore()` is the rollback path for every failed transaction, so the state it is asked to
   * destroy is the state something is trying to get *back* to. It used to clear both maps and
   * then rebuild; a feature the R-tree could not measure threw part-way through, and left the
   * store with nothing in it at all.
   */
  it('a snapshot carrying an unmeasurable geometry leaves the store exactly as it was', () => {
    const { crs, store } = setup()
    store._add('parcels', [{ geometry: rect(crs, ANKARA, 20, 20) }])
    store._add('buildings', [{ geometry: rect(crs, ANKARA, 5, 5) }])
    const before = store.snapshot()

    const poisoned: StoreSnapshot = {
      collections: {
        parcels: [
          ...before.collections['parcels']!,
          {
            ...before.collections['parcels']![0]!,
            id: 'poisoned',
            geometry: NULL_GEOMETRY,
          } as BlaeuFeature,
        ],
      },
      revision: before.revision + 1,
    }

    expect(() => store.restore(poisoned)).toThrow(/^\[blaeu\] cannot restore the store/)

    expect(store.snapshot()).toEqual(before)
    expect([...store.collections()].sort()).toEqual(['buildings', 'parcels'])
    expect(store.collection('parcels').size).toBe(1)
    expect(store.collection('buildings').size).toBe(1)
    // The index survived too, not just the feature map.
    expect(store.collection('parcels').query([32.0, 39.0, 33.0, 40.0])).toHaveLength(1)
  })

  it('a clean snapshot still restores', () => {
    const { crs, store } = setup()
    store._add('parcels', [{ geometry: rect(crs, ANKARA, 20, 20) }])
    const before = store.snapshot()
    store._add('parcels', [{ geometry: rect(crs, offsetMetres(crs, ANKARA, 80, 0), 20, 20) }])

    store.restore(before)
    expect(store.snapshot()).toEqual(before)
  })
})

describe('property keys that are not ordinary keys', () => {
  /**
   * `next['__proto__'] = value` runs the inherited setter instead of creating an own property:
   * the value silently fails to appear, and the object's prototype is replaced.
   */
  it('a __proto__ key in a patch becomes an own property and does not move the prototype', () => {
    const { crs, store, events } = setup()
    const [parcel] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 20, 20) }])

    // `JSON.parse`, not an object literal: `{ __proto__: x }` is literal *syntax* that sets the
    // prototype and creates no own property, so it could never reach `applyPatch` at all.
    // `JSON.parse` does create the own property — which is precisely how the key arrives, in
    // the `properties` bag of an imported GeoJSON feature.
    const patch = JSON.parse('{"__proto__":"malik","ada":"1234"}') as Record<string, string>
    expect(Object.hasOwn(patch, '__proto__')).toBe(true)

    new SetPropertiesCommand([parcel!.id], patch).execute({ store, events, crs } as never)

    const after = store.find(parcel!.id)!
    expect(after.properties['ada']).toBe('1234')
    // An own data property, not a prototype swap.
    expect(Object.hasOwn(after.properties, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(after.properties)).toBe(Object.prototype)
    expect(Object.keys(after.properties)).toContain('__proto__')
    // The value is readable as itself, which a prototype write would not make true.
    expect(Object.getOwnPropertyDescriptor(after.properties, '__proto__')?.value).toBe('malik')
  })

  it('a collection literally named __proto__ survives a snapshot round-trip', () => {
    const { crs, store } = setup()
    store._add('__proto__', [{ geometry: rect(crs, ANKARA, 20, 20) }])

    const snapshot = store.snapshot()
    expect(Object.hasOwn(snapshot.collections, '__proto__')).toBe(true)
    expect(snapshot.collections['__proto__']).toHaveLength(1)

    store._add('parcels', [{ geometry: rect(crs, offsetMetres(crs, ANKARA, 80, 0), 20, 20) }])
    store.restore(snapshot)
    expect(store.collection('__proto__').size).toBe(1)
    expect(store.collection('parcels').size).toBe(0)
  })
})

describe('a transient preview keeps its vertex count', () => {
  /**
   * The vertex tool addresses corners by positional index, captured at pointerdown and replayed
   * every frame. Anything that renumbers the ring mid-gesture — re-winding it (ADR 0011) or
   * collapsing a duplicated corner — makes every later frame move the wrong corner.
   */
  function ringOf(feature: BlaeuFeature): Position[] {
    return (feature.geometry as Polygon).coordinates[0]!
  }

  it('does not collapse a corner dragged onto its neighbour', () => {
    const { crs, store } = setup()
    const [parcel] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 20, 20) }])
    const ring = ringOf(parcel!)
    expect(ring).toHaveLength(5) // 4 corners + the closing vertex

    // Corner 1 dragged exactly onto corner 2 — what a 12 px topological snap makes easy.
    const collapsed: Position[] = [...ring]
    collapsed[1] = [...collapsed[2]!]

    const [preview] = store._update(
      [{ ...parcel!, geometry: { type: 'Polygon', coordinates: [collapsed] } } as BlaeuFeature],
      { rewindRings: false },
    )

    // Still four corners: index 3 still names the corner the drag started against.
    expect(ringOf(preview!)).toHaveLength(5)
    expect(ringOf(preview!)[3]).toEqual(ring[3])
  })

  it('the durable commit does collapse it, so nothing duplicated is ever stored', () => {
    const { crs, store } = setup()
    const [parcel] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 20, 20) }])
    const ring = ringOf(parcel!)

    const collapsed: Position[] = [...ring]
    collapsed[1] = [...collapsed[2]!]

    const [durable] = store._update([
      { ...parcel!, geometry: { type: 'Polygon', coordinates: [collapsed] } } as BlaeuFeature,
    ])

    expect(ringOf(durable!)).toHaveLength(4) // 3 corners + the closing vertex
  })

  /**
   * The LineString analogue, and the one the ring's `area2 === 0` guard does not cover.
   *
   * A line has no area, so its vertex count is its only gate — and when cardinality is being
   * preserved that count must still be taken on the *deduped* form, or `[A, A]` measures 2 and
   * a degenerate line reaches the store. It would then be re-normalised by the durable commit,
   * collapse to one vertex, and throw from outside any Command: straight out of the pointerup
   * handler rather than into a `map:error`.
   */
  it('rejects a fully collapsed line even while preserving preview cardinality', () => {
    const { crs, store } = setup()
    const at = offsetMetres(crs, ANKARA, 0, 0)
    const [line] = store._add('parcels', [
      {
        geometry: {
          type: 'LineString',
          coordinates: [[...at], [...offsetMetres(crs, ANKARA, 30, 0)]],
        },
      },
    ])

    expect(() =>
      store._update(
        [
          {
            ...line!,
            geometry: { type: 'LineString', coordinates: [[...at], [...at]] },
          } as BlaeuFeature,
        ],
        { rewindRings: false },
      ),
    ).toThrow(/collapsed to 1 distinct/)
  })

  it('still preserves a valid line’s cardinality through a preview', () => {
    const { crs, store } = setup()
    const a = offsetMetres(crs, ANKARA, 0, 0)
    const b = offsetMetres(crs, ANKARA, 30, 0)
    const [line] = store._add('parcels', [
      { geometry: { type: 'LineString', coordinates: [[...a], [...b]] } },
    ])

    // Three vertices, two of them coincident: still a valid line, and the preview keeps all 3
    // so the tool's positional refs stay put. Guards against a naive "just always dedupe" fix.
    const [preview] = store._update(
      [
        {
          ...line!,
          geometry: { type: 'LineString', coordinates: [[...a], [...a], [...b]] },
        } as BlaeuFeature,
      ],
      { rewindRings: false },
    )
    expect((preview!.geometry as { coordinates: Position[] }).coordinates).toHaveLength(3)

    // And the durable commit collapses it to 2, exactly as a ring collapses on release.
    const [durable] = store._update([
      {
        ...preview!,
        geometry: { type: 'LineString', coordinates: [[...a], [...a], [...b]] },
      } as BlaeuFeature,
    ])
    expect((durable!.geometry as { coordinates: Position[] }).coordinates).toHaveLength(2)
  })

  it('an untouched corner keeps its coordinates through a preview', () => {
    const { crs, store } = setup()
    const [parcel] = store._add('parcels', [{ geometry: rect(crs, ANKARA, 20, 20) }])
    const ring = ringOf(parcel!)

    const collapsed: Position[] = [...ring]
    collapsed[1] = [...collapsed[2]!]

    const [preview] = store._update(
      [{ ...parcel!, geometry: { type: 'Polygon', coordinates: [collapsed] } } as BlaeuFeature],
      { rewindRings: false },
    )

    for (const index of [0, 2, 3]) {
      expect(ringOf(preview!)[index]).toEqual(ring[index])
    }
  })
})
