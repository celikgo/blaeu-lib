/**
 * The regression test for audit HIGH #16.
 *
 * `deriveAreaMiddleware` used to build its own `CrsService` from the crs *code* the preset was
 * configured with, and project every area into that one frozen plane forever. So a host that
 * called `map.crs.setWorking(otherBelt)` at runtime — a first-class operation now: the topology
 * index rebuilds and the measure plugin re-derives its labels on a plane change — kept stamping
 * `yüzölçümü` computed on the *original* TM belt. The number on the deed silently disagreed with
 * the plane the surveyor was working in, off by the belts' scale-factor difference.
 *
 * The fix reads the live CRS off `CommitContext`. This test proves it through the public API: a
 * parcel's area, re-derived after switching belts, follows the new belt.
 *
 * TM30 (EPSG:5254) and TM33 (EPSG:5255) are different transverse-Mercator belts. Ankara sits
 * 2.85° east of TM30's central meridian (scale k² ≈ 1.0015) but almost on TM33's, so the same
 * ground parcel measures ~3 m² larger on TM30 than on TM33 — a gap far outside float noise.
 */
import { describe, expect, it } from 'vitest'
import { createTestMap } from '@blaeu/core/testing'
import { AddFeaturesCommand, UpdateFeaturesCommand } from '@blaeu/core'
import type { Polygon } from 'geojson'

import { cadastrePreset } from './preset.js'
import { AREA_PROPERTY } from './schema.js'

/** A ~50 m square at Ankara — squarely inside both the TM30 and TM33 belts. */
const SW: [number, number] = [32.85, 39.93]
const PARCEL: Polygon = {
  type: 'Polygon',
  coordinates: [[SW, [32.8506, 39.93], [32.8506, 39.9305], [32.85, 39.9305], SW]],
}

async function cadastreMap() {
  const map = await createTestMap({
    preset: cadastrePreset({ crs: 'EPSG:5254', locale: 'en' }), // TM30
  })
  await map.commands.commit(
    new AddFeaturesCommand('parcels', [{ id: 'p', geometry: PARCEL, properties: {} }]),
  )
  return map
}

const storedArea = (map: Awaited<ReturnType<typeof cadastreMap>>): number =>
  map.store.find('p')!.properties[AREA_PROPERTY] as number

describe('the derived area follows the map’s live working CRS', () => {
  it('re-derives on the belt set at runtime, not the belt the preset was built with', async () => {
    const map = await cadastreMap()
    const areaTM30 = storedArea(map)
    expect(areaTM30).toBeGreaterThan(0)
    // The initial commit derived on the preset's belt, which matches the live one.
    expect(areaTM30).toBeCloseTo(map.crs.area(map.store.find('p')!.geometry), 0)

    // Switch the working plane to a different belt. In production a deployment picks one belt,
    // but the kernel supports switching it, and when it does the deed area must follow.
    map.crs.setWorking('EPSG:5255') // TM33

    // Re-commit the parcel unchanged — geometry identical, only the plane has moved — so the
    // only thing that can change the stamped area is which belt it is projected onto.
    await map.commands.commit(new UpdateFeaturesCommand([map.store.find('p')!]))
    const areaTM33 = storedArea(map)

    // The re-derived area is the area on the *live* plane now...
    expect(areaTM33).toBeCloseTo(map.crs.area(map.store.find('p')!.geometry), 0)
    // ...and it genuinely moved off the TM30 value: the belts' scale factors differ by ~3 m².
    // Before the fix, the frozen TM30 service kept stamping the old number and this gap was 0.
    expect(Math.abs(areaTM33 - areaTM30)).toBeGreaterThan(1)

    await map.destroy()
  })
})
