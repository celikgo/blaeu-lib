import { describe, expect, it } from 'vitest'
import { createTestMap } from './createTestMap.js'
import { FakeRenderer } from './FakeRenderer.js'
import {
  ANKARA,
  distanceMetres,
  gridOfParcels,
  parcelFixture,
  sharedEdgeParcels,
  sliverParcels,
} from './fixtures.js'
import { expectWithinMetres } from './matchers.js'
import type { Tool } from '../types/extensions.js'
import type { InteractionContext } from '../types/pipeline.js'

describe('FakeRenderer projection', () => {
  it('project/unproject are exact inverses', () => {
    const r = new FakeRenderer({ camera: { center: ANKARA, zoom: 16 } })
    for (const lngLat of [ANKARA, [32.86, 39.94], [-122.4, 37.8], [0, 0], [10, 60]] as const) {
      const back = r.unproject(r.project(lngLat))
      expectWithinMetres(back, lngLat as [number, number], 1e-6)
    }
  })

  it('is conformal: a pixel is the same ground distance in x and y', () => {
    const r = new FakeRenderer({ camera: { center: ANKARA, zoom: 16 } })
    const centre = r.project(ANKARA)
    const east = r.unproject({ x: centre.x + 100, y: centre.y })
    const north = r.unproject({ x: centre.x, y: centre.y - 100 })

    // The property a snap tolerance depends on: 100 px is 100 px in every direction.
    // (Within 1%, because Web Mercator is spherical and `distanceMetres` is
    // ellipsoidal — the same ~0.4% gap a real MapLibre map has.)
    const dEast = distanceMetres(ANKARA, east)
    const dNorth = distanceMetres(ANKARA, north)
    expect(Math.abs(dEast - dNorth) / dEast).toBeLessThan(0.01)

    // And it is genuinely non-linear in latitude: the same 100 px step spans a
    // different number of degrees at 60°N than at the equator. A linear fake would
    // return the same number twice, and every pixel-denominated test would be a lie.
    const equator = new FakeRenderer({ camera: { center: [0, 0], zoom: 16 } })
    const high = new FakeRenderer({ camera: { center: [0, 60], zoom: 16 } })
    const dLatEquator = equator.unproject({ x: 400, y: 200 })[1] - 0
    const dLatHigh = high.unproject({ x: 400, y: 200 })[1] - 60
    // Mercator stretches high latitudes, so a pixel there spans *fewer* degrees —
    // by a factor of cos(60°) = 0.5. That factor is precisely what makes a
    // degree-denominated tolerance (`toBeCloseTo(lat, 6)`) mean something different
    // in Oslo than in Ankara.
    expect(dLatHigh / dLatEquator).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 3)
  })
})

describe('createTestMap', () => {
  it('seeds features through the real command path', async () => {
    const map = await createTestMap({ features: { parcels: sharedEdgeParcels() } })
    expect(map.store.collection('parcels').size).toBe(2)
    // One command, one store change, one setData: the coalescing assertion works.
    expect(map.test.renderer.setDataCallsBySource.get('parcels')).toBe(1)
    await map.destroy()
  })

  it('drives a tool through the real interaction pipeline, in pixels', async () => {
    const seen: InteractionContext[] = []
    const map = await createTestMap({ features: { parcels: [parcelFixture('a')] } })

    const tool: Tool = {
      id: 'test:probe',
      activate: () => {},
      deactivate: () => {},
      onPointerDown: (ctx) => void seen.push(ctx),
      onPointerMove: (ctx) => void seen.push(ctx),
      onPointerUp: (ctx) => void seen.push(ctx),
      onClick: (ctx) => void seen.push(ctx),
      onKeyDown: (ctx) => void seen.push(ctx),
    }
    map.tools.register('test:probe', tool)
    map.tools.activate('test:probe')

    // Middleware that nudges the pointer 1 px east proves the pipeline runs and that
    // xy stays derived from the (rewritten) lngLat.
    map.interaction.use((ctx, next) => {
      const p = map.test.project(ctx.lngLat)
      ctx.lngLat = map.test.unproject({ x: p.x + 1, y: p.y })
      next()
    })

    map.test.click(ANKARA)
    map.test.drag(ANKARA, [32.851, 39.931], { steps: 4 })
    map.test.key('Escape')

    expect(seen.map((c) => c.kind)).toEqual([
      'click',
      'pointerdown',
      'pointermove',
      'pointermove',
      'pointermove',
      'pointermove',
      'pointerup',
      'keydown',
    ])
    expect(seen.at(-1)?.key).toBe('Escape')

    const click = seen[0]!
    expect(map.test.project(click.lngLat).x - map.test.project(click.rawLngLat).x).toBeCloseTo(1, 6)
    expect(click.xy).toEqual(map.crs.working.forward(click.lngLat))
    await map.destroy()
  })

  it('hit-tests headlessly', async () => {
    const map = await createTestMap({ features: { parcels: [parcelFixture('a')] } })
    const inside = map.test.project([ANKARA[0] + 0.0002, ANKARA[1] + 0.0001])
    const outside = map.test.project([ANKARA[0] - 0.01, ANKARA[1] - 0.01])

    expect(map.test.renderer.queryAt(inside).map((f) => f.id)).toEqual(['a'])
    expect(map.test.renderer.queryAt(outside)).toEqual([])
    await map.destroy()
  })

  it('leaves nothing behind on destroy', async () => {
    const map = await createTestMap({ features: { parcels: gridOfParcels(9) } })
    expect(map.store.collection('parcels').size).toBe(9)
    await map.destroy()
    expect(map.debug.snapshot()['listeners']).toBe(0)
    expect(map.test.renderer.destroyed).toBe(true)
  })
})

describe('fixtures', () => {
  it('sliverParcels are 0.4 mm apart', () => {
    const [left, right] = sliverParcels()
    const leftEdge = (left.geometry as { coordinates: number[][][] }).coordinates[0]![1]!
    const rightEdge = (right.geometry as { coordinates: number[][][] }).coordinates[0]![0]!
    const gap = distanceMetres([leftEdge[0]!, leftEdge[1]!], [rightEdge[0]!, rightEdge[1]!])
    expect(gap).toBeGreaterThan(0)
    expect(gap * 1000).toBeCloseTo(0.4, 3)
  })

  it('sharedEdgeParcels share their corners bit-for-bit', () => {
    const [left, right] = sharedEdgeParcels()
    const l = (left.geometry as { coordinates: number[][][] }).coordinates[0]!
    const r = (right.geometry as { coordinates: number[][][] }).coordinates[0]!
    expect(l[1]).toEqual(r[0])
    expect(l[2]).toEqual(r[3])
  })

  it('parcelFixture is ~2000 m2', () => {
    const ring = (parcelFixture().geometry as { coordinates: number[][][] }).coordinates[0]!
    const w = distanceMetres([ring[0]![0]!, ring[0]![1]!], [ring[1]![0]!, ring[1]![1]!])
    const h = distanceMetres([ring[1]![0]!, ring[1]![1]!], [ring[2]![0]!, ring[2]![1]!])
    expect(w * h).toBeCloseTo(2000, 0)
  })
})

describe('expectWithinMetres', () => {
  it('fails outside the tolerance and passes inside it', () => {
    expect(() => expectWithinMetres(ANKARA, [ANKARA[0] + 0.001, ANKARA[1]], 0.001)).toThrow(/away/)
    expect(() => expectWithinMetres(ANKARA, ANKARA, 0.001)).not.toThrow()
    expect(() => expectWithinMetres([NaN, NaN], ANKARA, 1e9)).toThrow(/NaN/)
  })
})
