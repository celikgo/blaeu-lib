/**
 * The cadastre's own judgement about a GeometryCollection parcel.
 *
 * The topology plugin now *measures* a collection — it flattens it to its polygonal content, so
 * a GC parcel can no longer switch the overlap rule off for itself or for its neighbours (see
 * `plugin-topology/src/geometry-collection.test.ts`). This file pins the separate, higher-tier
 * decision: measurable is not the same as storable. A parcel whose geometry is a collection has
 * no single boundary to describe, and core's `eachVertex` deliberately declines to address a
 * collection's members — `VertexRef` has no way to name one — so the vertex tool cannot edit it
 * at all. It would be a parcel that looks fine on screen and is a dead end.
 *
 * So the preset refuses it, as an `error`, because the fix is mechanical: flatten to a
 * MultiPolygon on import.
 */
import { describe, expect, it } from 'vitest'
import { createTestMap, ANKARA, offsetMetres } from '@blaeu/core/testing'
import { AddFeaturesCommand } from '@blaeu/core'
import type { Geometry, Polygon, Position } from 'geojson'

import { cadastrePreset } from './preset.js'
import { PARCEL_GEOMETRY_RULE_ID } from './validation.js'
import { AREA_PROPERTY } from './schema.js'
import { DERIVE_AREA_ID, deriveAreaMiddleware } from './derive.js'

function rect(dx: number, dy: number, width: number, height: number): Polygon {
  const at = (x: number, y: number): Position => [...offsetMetres(ANKARA, dx + x, dy + y)]
  return {
    type: 'Polygon',
    coordinates: [[at(0, 0), at(width, 0), at(width, height), at(0, height), at(0, 0)]],
  }
}

const BASE = rect(0, 0, 50, 40)
const wrap = (geometry: Polygon): Geometry => ({
  type: 'GeometryCollection',
  geometries: [geometry],
})

const cadastreMap = () =>
  createTestMap({ preset: cadastrePreset({ crs: 'EPSG:5254', locale: 'en' }) })

const add = (
  map: Awaited<ReturnType<typeof cadastreMap>>,
  id: string,
  geometry: Geometry,
): ReturnType<typeof map.commands.commit> =>
  map.commands.commit(new AddFeaturesCommand('parcels', [{ id, geometry, properties: {} }]))

describe('a parcel must be a Polygon or MultiPolygon', () => {
  it('refuses a GeometryCollection parcel and does not store it', async () => {
    const map = await cadastreMap()
    const result = await add(map, 'A', wrap(BASE))

    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toMatch(/GeometryCollection/)
    expect(map.store.find('A')).toBeUndefined()
  })

  it('names the type in the message, so the importer knows what to flatten', async () => {
    const map = await cadastreMap()
    const issues = await map.validation.run([
      {
        id: 'A',
        geometry: wrap(BASE),
        properties: {},
        meta: { collection: 'parcels', version: 1, createdAt: 0, updatedAt: 0 },
      } as never,
    ])

    const issue = issues.find((i) => i.rule === PARCEL_GEOMETRY_RULE_ID)
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
    expect(issue?.message).toMatch(/cannot be a GeometryCollection/)
    expect(issue?.message).toMatch(/Polygon or MultiPolygon/)
  })

  it('accepts an ordinary Polygon parcel, and says nothing about it', async () => {
    const map = await cadastreMap()
    expect((await add(map, 'A', BASE)).ok).toBe(true)

    const issues = await map.validation.run([map.store.find('A')!])
    expect(issues.find((i) => i.rule === PARCEL_GEOMETRY_RULE_ID)).toBeUndefined()
  })

  it('accepts a MultiPolygon parcel — a parcel in two detached pieces is real', async () => {
    const map = await cadastreMap()
    const multi: Geometry = {
      type: 'MultiPolygon',
      coordinates: [BASE.coordinates, rect(200, 0, 30, 30).coordinates],
    }
    expect((await add(map, 'A', multi)).ok).toBe(true)
    expect(map.store.find('A')).toBeDefined()
  })

  it('leaves a non-parcel collection alone — the rule is scoped to the parcel layer', async () => {
    const map = await cadastreMap()
    // Buildings are a different collection, and `sınırlandırma` is not defined for them.
    const result = await map.commands.commit(
      new AddFeaturesCommand('buildings', [
        { id: 'b1', geometry: wrap(rect(5, 5, 10, 10)), properties: {} },
      ]),
    )
    expect(result.ok).toBe(true)
    expect(map.store.find('b1')).toBeDefined()
  })
})

describe('the area derivation still understands a collection', () => {
  /**
   * The derive middleware runs *ahead* of validation in the commit pipeline, so it stamps the
   * area before the geometry-type rule votes. That ordering is why widening its own
   * `isPolygonal` mattered: without it a collection reached validation with no `yüzölçümü`, and
   * a host that lowered this rule to a warning would store a parcel with no area at all.
   *
   * Driven through the middleware, on a map that installs it **without** the geometry-type
   * rule — which is the only way the derivation on a collection is observable, since the full
   * preset refuses to store one. This is not a contrived arrangement: `deriveAreaMiddleware` is
   * exported and usable standalone, it runs *ahead* of validation in the pipeline, and a host
   * that lowers the geometry-type rule to a warning stores the parcel and needs its area.
   */
  it('stamps yuzolcumu on a collection when the geometry-type rule is not in the way', async () => {
    const map = await createTestMap({
      config: { crs: { working: 'EPSG:5254' } },
      preset: {
        id: 'derive-only',
        commitMiddleware: [
          [deriveAreaMiddleware({ collection: 'parcels', decimals: 2 }), { id: DERIVE_AREA_ID }],
        ],
      },
    })

    const result = await map.commands.commit(
      new AddFeaturesCommand('parcels', [{ id: 'A', geometry: wrap(BASE), properties: {} }]),
    )
    expect(result.ok).toBe(true)

    const wrapped = map.store.find('A')!
    expect(typeof wrapped.properties[AREA_PROPERTY]).toBe('number')

    // The number a bare Polygon of the same ground would get.
    await map.commands.commit(
      new AddFeaturesCommand('parcels', [{ id: 'B', geometry: BASE, properties: {} }]),
    )
    expect(wrapped.properties[AREA_PROPERTY]).toBe(map.store.find('B')!.properties[AREA_PROPERTY])
  })

  it('derives the same number for a wrapped parcel as for the bare one', async () => {
    const map = await cadastreMap()
    await add(map, 'plain', BASE)
    const plain = map.store.find('plain')!.properties[AREA_PROPERTY] as number

    // ~2003 m², not 2000: Ankara sits 2.85° east of TM30's central meridian, so the belt's
    // scale factor inflates a 50 × 40 ground parcel by k² ≈ 1.0015. That is the projected
    // area a Turkish deed carries, and it is the number this preset exists to get right.
    expect(plain).toBeGreaterThan(2000)
    expect(plain).toBeCloseTo(2002.93, 1)

    // Wrapping a geometry in a collection must not change what it measures. Compared against
    // the *stored* geometry, not the fixture: ingest quantises to the belt's precision grid,
    // which moves the area by ~0.01 m² — and it is the stored shape the middleware measured.
    const stored = map.store.find('plain')!.geometry
    expect(map.crs.area({ type: 'GeometryCollection', geometries: [stored] })).toBe(
      map.crs.area(stored),
    )
    expect(Math.round(map.crs.area(stored) * 100) / 100).toBe(plain)
  })
})
