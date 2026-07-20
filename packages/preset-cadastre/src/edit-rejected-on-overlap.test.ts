/**
 * The regression test for the audit's "cadastre validation never runs on a vertex drag".
 *
 * Same root cause as the derive-area critical: while edits went through `dispatch()`, the
 * commit pipeline never ran, so the cadastre overlap rule never saw an interactive edit. A
 * surveyor could drag a corner of one parcel clean into its neighbour and the store would keep
 * the overlapping geometry — a boundary dispute written silently, that a `commit()` would have
 * refused.
 *
 * Now an edit commits on pointer release, through the real pipeline, so the overlap rule votes
 * and the controller reverts the parcel when it is vetoed. This goes through the public edit
 * API on a map built from the real preset and asserts on `map.store` and the rejection event —
 * the two things that cannot lie about whether validation actually ran. If a future change
 * routes an edit around the commit pipeline again, this fails.
 */
import { describe, expect, it } from 'vitest'
import { createTestMap, ANKARA, offsetMetres } from '@blaeu/core/testing'
import { AddFeaturesCommand } from '@blaeu/core'
import type { Polygon } from 'geojson'

import { cadastrePreset } from './preset.js'

/** Parcel A: a 50 m × 40 m square at Ankara. Its NE corner is the one we drag. */
const A_NE = offsetMetres(ANKARA, 50, 40)
const PARCEL_A: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [...ANKARA],
      [...offsetMetres(ANKARA, 50, 0)],
      [...A_NE],
      [...offsetMetres(ANKARA, 0, 40)],
      [...ANKARA],
    ],
  ],
}

/**
 * Parcel B: a 100 m block whose west edge is 30 m east of A, with a tall latitude span. The gap
 * means A and B are disjoint at rest (so seeding is valid and no vertex is shared — topological
 * editing has nothing to co-move); the block is wide and tall so a corner dragged 40 m into its
 * interior lands well clear of every B edge and vertex, out of any snap tolerance.
 */
const PARCEL_B: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [...offsetMetres(ANKARA, 80, -30)],
      [...offsetMetres(ANKARA, 180, -30)],
      [...offsetMetres(ANKARA, 180, 70)],
      [...offsetMetres(ANKARA, 80, 70)],
      [...offsetMetres(ANKARA, 80, -30)],
    ],
  ],
}

async function cadastreMap() {
  const map = await createTestMap({
    preset: cadastrePreset({ crs: 'EPSG:5254', locale: 'en' }),
  })
  await map.commands.commit(
    new AddFeaturesCommand('parcels', [
      { id: 'A', geometry: PARCEL_A, properties: {} },
      { id: 'B', geometry: PARCEL_B, properties: {} },
    ]),
  )
  return map
}

const geometryOf = (map: Awaited<ReturnType<typeof cadastreMap>>, id: string): string =>
  JSON.stringify(map.store.find(id)!.geometry)

describe('a vertex drag into a neighbour is rejected by cadastre validation', () => {
  it('reverts the parcel and reports the overlap, instead of silently writing it', async () => {
    const map = await cadastreMap()
    const aBefore = geometryOf(map, 'A')
    const bBefore = geometryOf(map, 'B')

    const rejected: string[] = []
    map.events.on('commit:rejected', (e) => rejected.push(e.payload.reason))

    // Drag A's NE corner 70 m east — from the gap, deep into B's interior.
    map.plugin('edit').edit('A')
    map.test.drag(A_NE, offsetMetres(ANKARA, 120, 40), { steps: 8 })
    // The drag previews synchronously; the validated write lands on release, async.
    await map.test.flush()

    // The commit pipeline ran the overlap rule, which vetoed the write.
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatch(/overlap/i)
    // And the controller put A back exactly as it was — the overlap never reached the store.
    expect(geometryOf(map, 'A')).toBe(aBefore)
    expect(geometryOf(map, 'B')).toBe(bBefore)

    await map.destroy()
  })

  it('accepts the same drag when it stays clear of the neighbour', async () => {
    // The contrast that proves the revert above is the veto, not a broken drag: an identical
    // gesture that does not create an overlap commits and moves the corner.
    const map = await cadastreMap()
    const aBefore = geometryOf(map, 'A')

    const rejected: string[] = []
    map.events.on('commit:rejected', (e) => rejected.push(e.payload.reason))

    // Drag A's NE corner 20 m *north*, away from B: still disjoint, so no overlap.
    map.plugin('edit').edit('A')
    map.test.drag(A_NE, offsetMetres(ANKARA, 50, 60), { steps: 8 })
    await map.test.flush()

    expect(rejected).toHaveLength(0)
    expect(geometryOf(map, 'A')).not.toBe(aBefore)

    await map.destroy()
  })
})
