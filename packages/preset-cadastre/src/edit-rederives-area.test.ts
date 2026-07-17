/**
 * The regression test for the audit's load-bearing critical.
 *
 * For a while, every geometry edit went through `commands.dispatch()`, which skips
 * the commit pipeline — so `deriveAreaMiddleware` never ran on an edit. The area was
 * derived once, when the parcel was added, and then never again: drag a corner and
 * the boundary said 8 012 m² while the stamped `yüzölçümü` still said 2 000. The deed
 * and the parcel disagreed, silently, and no test caught it because the derive-area
 * test constructed the middleware and called it directly — it tested the part, not the
 * wire.
 *
 * This one goes through the public API. It commits a parcel and then edits it with a
 * real drag, on a map built from the real preset, and asserts on `map.store` — the one
 * thing that cannot lie about whether the derive actually ran. If a future change
 * routes an edit around the commit pipeline again, this fails.
 */
import { describe, expect, it } from 'vitest'
import { createTestMap, offsetMetres } from '@blaeu/core/testing'
import { AddFeaturesCommand } from '@blaeu/core'
import type { Polygon } from 'geojson'

import { cadastrePreset } from './preset.js'
import { AREA_PROPERTY } from './schema.js'

/** A ~50 m square at Ankara. Its NE corner is the one we drag outward. */
const SW: [number, number] = [32.85, 39.93]
const NE: [number, number] = [32.8505, 39.9305]
const PARCEL: Polygon = {
  type: 'Polygon',
  coordinates: [[SW, [32.8505, 39.93], NE, [32.85, 39.9305], SW]],
}

/** A map from the real preset, with one parcel *committed through the pipeline* so its area is derived. */
async function cadastreMap() {
  const map = await createTestMap({
    preset: cadastrePreset({ crs: 'EPSG:5254', locale: 'en' }),
  })
  await map.commands.commit(
    new AddFeaturesCommand('parcels', [{ id: 'p', geometry: PARCEL, properties: {} }]),
  )
  return map
}

const storedArea = (map: Awaited<ReturnType<typeof cadastreMap>>): number =>
  map.store.find('p')!.properties[AREA_PROPERTY] as number

const boundaryArea = (map: Awaited<ReturnType<typeof cadastreMap>>): number =>
  map.crs.area(map.store.find('p')!.geometry)

describe('a geometry edit re-derives the cadastral area', () => {
  it('derives yüzölçümü from the boundary on the initial commit', async () => {
    const map = await cadastreMap()
    // The number on the deed is the number the corners imply — derived, never typed.
    expect(storedArea(map)).toBeCloseTo(boundaryArea(map), 0)
    await map.destroy()
  })

  it('re-derives yüzölçümü from the edited boundary after a vertex drag', async () => {
    const map = await cadastreMap()
    const before = storedArea(map)
    expect(before).toBeGreaterThan(0)

    // Pull the NE corner ~20 m out along both axes: the parcel gets materially bigger.
    map.plugin('edit').edit('p')
    map.test.drag(NE, offsetMetres(NE, 20, 20), { steps: 8 })
    // The drag previews synchronously; the validated write — and the derive — land on
    // release, through the async commit pipeline.
    await map.test.flush()

    // The stored area followed the boundary: the deed and the parcel still agree.
    expect(storedArea(map)).toBeCloseTo(boundaryArea(map), 0)
    // And it genuinely changed — proof the derive ran on the edit, not just the add.
    expect(storedArea(map)).toBeGreaterThan(before + 100)

    await map.destroy()
  })

  it('undo restores the pre-edit area, exactly', async () => {
    const map = await cadastreMap()
    const before = storedArea(map)

    map.plugin('edit').edit('p')
    map.test.drag(NE, offsetMetres(NE, 20, 20), { steps: 8 })
    await map.test.flush()
    expect(storedArea(map)).toBeGreaterThan(before + 100)

    map.plugin('history').undo()
    await map.test.flush()

    // One Ctrl-Z walks back the whole drag — geometry and derived area together.
    expect(storedArea(map)).toBeCloseTo(before, 0)
    expect(storedArea(map)).toBeCloseTo(boundaryArea(map), 0)

    await map.destroy()
  })
})
