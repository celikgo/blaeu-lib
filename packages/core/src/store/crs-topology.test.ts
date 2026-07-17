/**
 * The regression test for the audit's `crs.setWorking()` critical.
 *
 * The topology index buckets every vertex by its position *in the working plane*. A
 * runtime `crs.setWorking()` moves that plane, so without a rebuild every bucket is
 * keyed to a plane that no longer exists — a lookup, now projecting into the new plane,
 * matches nothing, and two parcels that share a corner read as not sharing it. In a
 * land registry that is a sliver of land with no owner, not a rendering artefact.
 *
 * This goes through the real map, so it exercises the actual wire (`crs.onChange` →
 * `store.topology.rebuild`). If a future change drops that wire, this fails.
 */
import { describe, expect, it } from 'vitest'
import {
  createTestMap,
  sharedEdgeParcels,
  offsetMetres,
  ANKARA,
  PARCEL_WIDTH_M,
} from '../testing/index.js'
import { AddFeaturesCommand } from '../commands/builtins.js'

describe('crs.setWorking rebuilds the topology index', () => {
  it('keeps a shared corner shared after the working CRS changes belt', async () => {
    const map = await createTestMap({
      config: { crs: { working: 'EPSG:5254' } }, // TUREF / TM30
      features: { parcels: [...sharedEdgeParcels()] },
    })

    // The two parcels share the south-east corner of the left one.
    const shared = offsetMetres(ANKARA, PARCEL_WIDTH_M, 0)
    expect(map.store.topology.featuresAt(shared)).toHaveLength(2)

    // Switch belts — the plane every vertex was bucketed in changes underneath the index.
    map.crs.setWorking('EPSG:5255') // TUREF / TM33

    // Rebuilt in the new plane, the shared corner is still shared. Before the fix this
    // was 0 (or 1): the old-plane buckets and the new-plane query never met.
    expect(map.store.topology.featuresAt(shared)).toHaveLength(2)
    expect(map.store.topology.isShared(shared)).toBe(true)

    await map.destroy()
  })

  it('indexes a feature added after the switch in the new plane', async () => {
    const map = await createTestMap({
      config: { crs: { working: 'EPSG:5254' } },
      features: { parcels: [sharedEdgeParcels()[0]] }, // just the left parcel
    })

    map.crs.setWorking('EPSG:5255')
    // Add the neighbour after the switch: it must land in the same (new-plane) bucket as
    // the left parcel's corner, or new edits would not see old geometry as shared.
    await map.commands.commit(new AddFeaturesCommand('parcels', [sharedEdgeParcels()[1]]))

    const shared = offsetMetres(ANKARA, PARCEL_WIDTH_M, 0)
    expect(map.store.topology.featuresAt(shared)).toHaveLength(2)

    await map.destroy()
  })
})
