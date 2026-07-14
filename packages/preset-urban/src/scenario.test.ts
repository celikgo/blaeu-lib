import { beforeEach, describe, expect, it } from 'vitest'
import { SetPropertiesCommand, type FeatureInput, type Position } from '@fleximap/core'
import { createTestMap, ANKARA, offsetMetres, type TestMap } from '@fleximap/core/testing'

import { urbanPlanningPreset } from './preset.js'
import { scenarioPlugin } from './scenario.js'

/* ------------------------------------------------------------------------- */
/* Fixtures — two 40 m × 25 m blocks, side by side, on the Ankara TM33 belt    */
/* ------------------------------------------------------------------------- */

const BLOCK_W = 40
const BLOCK_H = 25
/** m², nominal. Both blocks are the same size, which makes every delta below readable by eye. */
const BLOCK_AREA = BLOCK_W * BLOCK_H

/**
 * Areas are asserted **relatively**, to 0.5 %.
 *
 * Not sloppiness — the two numbers are honestly different. The fixture lays its
 * corners out on a *local geodesic* metre grid at Ankara, while `crs.area()` measures
 * on the EPSG:5254 **plane**, whose grid scale factor is not 1 away from the central
 * meridian. A 1 000 m² block therefore projects to ~1 001.5 m², and that 0.15 % is
 * the projection being right rather than the fixture being wrong. What the scenario
 * report must get right is the *delta*, and a relative tolerance tests exactly that
 * without pretending the plane and the ellipsoid agree.
 */
function expectAreaAbout(actual: number | undefined, expected: number): void {
  expect(actual).toBeDefined()
  expect((actual ?? 0) / expected).toBeCloseTo(1, 2)
}

function block(id: string, zoning: string, eastMetres: number): FeatureInput {
  const origin = offsetMetres(ANKARA, eastMetres, 0)
  const corners = [
    origin,
    offsetMetres(origin, BLOCK_W, 0),
    offsetMetres(origin, BLOCK_W, BLOCK_H),
    offsetMetres(origin, 0, BLOCK_H),
    origin,
  ]
  // `LngLat` is a readonly tuple; GeoJSON's `Position` is not, and the store's ingest
  // is typed against GeoJSON. Copying is the honest conversion.
  const ring: Position[] = corners.map(([lng, lat]) => [lng, lat])

  return { id, geometry: { type: 'Polygon', coordinates: [ring] }, properties: { zoning } }
}

/** A 5 m gutter between the blocks: adjacent, not touching, so no overlap rule fires. */
const zoningFixture: readonly FeatureInput[] = [
  block('ada-1', 'K', 0),
  block('ada-2', 'T', BLOCK_W + 5),
]

async function urbanMap(): Promise<TestMap> {
  return createTestMap({
    preset: urbanPlanningPreset(),
    features: { zoning: [...zoningFixture] },
  })
}

/* ------------------------------------------------------------------------- */

describe('scenarios', () => {
  let map: TestMap

  beforeEach(async () => {
    map = await urbanMap()
  })

  it('is installed by the preset and typed without a cast', () => {
    const scenarios = map.plugin('scenario')
    expect(scenarios.active).toBeNull()
    expect(scenarios.list()).toEqual([])
  })

  it('reports per-category area, planar in the working CRS', () => {
    const scenarios = map.plugin('scenario')
    scenarios.create('Mevcut')

    const areas = new Map(scenarios.areas('Mevcut').map((row) => [row.code, row.areaM2]))

    // Planar area on the EPSG:5254 plane, in metres — not a spherical area, which at
    // this latitude would be wrong by enough that nobody would notice until a council
    // did.
    expectAreaAbout(areas.get('K'), BLOCK_AREA)
    expectAreaAbout(areas.get('T'), BLOCK_AREA)
    // Legend order, and categories with nothing in them still get a row — a report
    // with a missing line reads as "no data", not as "zero".
    expect(scenarios.areas('Mevcut').map((row) => row.code)).toEqual(['K', 'T', 'S', 'YA', 'D'])
    expect(areas.get('YA')).toBe(0)
  })

  it('compares two scenarios by category', async () => {
    const scenarios = map.plugin('scenario')
    scenarios.create('Mevcut')

    // The proposal: re-zone the commercial block to residential.
    await map.commands.commit(new SetPropertiesCommand(['ada-2'], { zoning: 'K' }))
    scenarios.create('Yoğun')

    const diff = scenarios.compare('Mevcut', 'Yoğun')
    const byCode = new Map(diff.categories.map((row) => [row.code, row]))

    const konut = byCode.get('K')
    expectAreaAbout(konut?.areaA, BLOCK_AREA)
    expectAreaAbout(konut?.areaB, BLOCK_AREA * 2)
    expectAreaAbout(konut?.deltaM2, BLOCK_AREA)
    // "Konut doubled." Not to the last digit: the two blocks sit at different
    // eastings, and the TM plane's scale factor is not identical at the two — which is
    // the projection telling the truth, and exactly why the report is computed on the
    // plane rather than from the nominal 40 × 25.
    expect(konut?.deltaPercent).toBeCloseTo(100, 1)

    const ticaret = byCode.get('T')
    expect(ticaret?.areaB).toBe(0)
    expectAreaAbout(ticaret?.deltaM2, -BLOCK_AREA)
    expect(ticaret?.deltaPercent).toBeCloseTo(-100, 6)

    // A category absent from `a` has not grown by a percentage; it appeared.
    expect(byCode.get('YA')?.deltaPercent).toBeNull()

    // The plan did not gain or lose land, it re-allocated it.
    expect(diff.totalB).toBeCloseTo(diff.totalA, 6)
    expect(diff.a).toBe('Mevcut')
    expect(diff.b).toBe('Yoğun')
  })

  it('checks the current work in before switching away, and restores it on the way back', async () => {
    const scenarios = map.plugin('scenario')
    scenarios.create('Mevcut')

    scenarios.create('Yoğun')
    await map.commands.commit(new SetPropertiesCommand(['ada-2'], { zoning: 'K' }))

    scenarios.switch('Mevcut')
    expect(map.store.find('ada-2')?.properties['zoning']).toBe('T')
    expect(scenarios.active).toBe('Mevcut')

    // The edit made while "Yoğun" was active was saved into it, not lost — this is the
    // difference between a scenario tool and a trap.
    scenarios.switch('Yoğun')
    expect(map.store.find('ada-2')?.properties['zoning']).toBe('K')
  })

  it('switching is a Command, so it undoes to deep equality', async () => {
    const scenarios = map.plugin('scenario')
    scenarios.create('Mevcut')

    await map.commands.commit(new SetPropertiesCommand(['ada-1'], { zoning: 'S' }))
    scenarios.create('Sanayi')

    const before = map.store.snapshot()
    scenarios.switch('Mevcut')
    expect(map.store.snapshot()).not.toEqual(before)

    expect(map.plugin('history').undo()).toBe(true)
    // Deep equality, no tolerance. If this ever needs loosening, the command captured
    // too little state.
    expect(map.store.snapshot()).toEqual(before)
  })

  it('names the scenarios you have when you ask for one you do not', () => {
    const scenarios = map.plugin('scenario')
    scenarios.create('Mevcut')

    expect(() => scenarios.switch('Seyrek')).toThrow(/Known scenarios: Mevcut/)
    expect(() => scenarios.create('Mevcut')).toThrow(/already exists/)
    expect(() => scenarios.compare('Mevcut', 'Seyrek')).toThrow(/no such scenario/)
  })

  it('clears the active scenario when it is removed', () => {
    const scenarios = map.plugin('scenario')
    const seen: (string | null)[] = []
    scenarios.onChange((active) => seen.push(active))

    scenarios.create('Mevcut')
    scenarios.remove('Mevcut')

    expect(scenarios.active).toBeNull()
    expect(seen).toEqual(['Mevcut', null])
  })
})

/* ------------------------------------------------------------------------- */
/* The two tests every plugin owes: degradation and teardown                   */
/* ------------------------------------------------------------------------- */

describe('the scenario plugin on its own', () => {
  it('works with no preset and no other plugin — it depends on nothing', async () => {
    const solo = await createTestMap({
      plugins: [scenarioPlugin({ collection: 'zoning' })],
      features: { zoning: [...zoningFixture] },
    })

    solo.plugin('scenario').create('a')
    expect(solo.plugin('scenario').areas('a')[0]?.areaM2).toBeGreaterThan(0)
  })

  it('leaks nothing on removal', async () => {
    const solo = await createTestMap({ plugins: [scenarioPlugin()] })
    const before = solo.debug.snapshot()

    solo.plugin('scenario').onChange(() => {})
    await solo.remove('scenario')

    expect(solo.debug.snapshot()).toMatchObject({
      listeners: before['listeners'],
      middleware: before['middleware'],
      layers: before['layers'],
      plugins: 0,
    })
  })
})
