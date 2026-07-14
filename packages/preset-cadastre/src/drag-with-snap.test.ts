/**
 * Editing a parcel while the snap plugin is installed.
 *
 * These two plugins ship together in the cadastre preset, and for a while installing
 * the *optional* snap plugin silently broke the *required* edit one: the dragged vertex
 * — and the handle drawn on top of it, which is a real feature in the store — sat under
 * the cursor, so the snap engine helpfully offered the pointer its own starting position,
 * the tool computed "the vertex did not move", and it never moved again. Every drag
 * shorter than the snap tolerance was a silent no-op, and a scale gesture was pinned at
 * 1:1. Nothing threw. Nothing looked wrong. The parcel simply would not edit.
 *
 * The fix is in the kernel, not in a conversation between the two plugins: a tool
 * declares what it has hold of (`tools.setDragging`), scaffolding declares that it is not
 * geometry (`meta.snappable === false`), and any middleware may act on either. `plugin-edit`
 * still does not import `plugin-snap`, and `plugin-snap` still does not import `plugin-edit`.
 */
import { describe, expect, it } from 'vitest'
import { createTestMap } from '@fleximap/core/testing'
import { snapPlugin } from '@fleximap/plugin-snap'
import type { Polygon } from 'geojson'

import { editPlugin } from '@fleximap/plugin-edit'

/** A 43 m square at Ankara. Its SE corner is the one we drag. */
const PARCEL: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [32.85, 39.93],
      [32.8505, 39.93],
      [32.8505, 39.9305],
      [32.85, 39.9305],
      [32.85, 39.93],
    ],
  ],
}

/** Its neighbour, sharing the eastern edge — the thing a surveyor genuinely wants to snap to. */
const NEIGHBOUR: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [32.8506, 39.93],
      [32.8511, 39.93],
      [32.8511, 39.9305],
      [32.8506, 39.9305],
      [32.8506, 39.93],
    ],
  ],
}

const SE: [number, number] = [32.8505, 39.93]

async function makeMap(withNeighbour = false) {
  const map = await createTestMap({
    plugins: [snapPlugin({ tolerance: 12 }), editPlugin()],
    features: {
      parcels: withNeighbour
        ? [
            { id: 'p', geometry: PARCEL },
            { id: 'q', geometry: NEIGHBOUR },
          ]
        : [{ id: 'p', geometry: PARCEL }],
    },
  })
  map.plugin('edit').edit('p')
  return map
}

function ringOf(map: Awaited<ReturnType<typeof makeMap>>, id: string): number[][] {
  return (map.store.find(id)!.geometry as Polygon).coordinates[0]!
}

describe('dragging a vertex with the snap plugin installed', () => {
  it('lands where it was dropped — it does not snap to itself', async () => {
    const map = await makeMap()
    const to: [number, number] = [32.85056, 39.93006] // ~8 m NE, well inside snap tolerance

    map.test.drag(SE, to, { steps: 8 })
    await map.test.flush()

    const nearest = Math.min(...ringOf(map, 'p').map((c) => map.crs.distance([c[0]!, c[1]!], to)))
    // Before the fix this was 10.98 m — the distance back to where the drag started,
    // because the vertex had not moved at all.
    expect(nearest).toBeLessThan(0.05)

    map.destroy()
  })

  it('still snaps to a neighbouring parcel’s corner — the fix did not just switch snapping off', async () => {
    const map = await makeMap(true)
    const target: [number, number] = [32.8506, 39.93] // the neighbour's SW corner
    // Aim *near* it, not at it. Only snapping can close the last few metres.
    const nearby: [number, number] = [32.850595, 39.930004]

    map.test.drag(SE, nearby, { steps: 8 })
    await map.test.flush()

    const nearest = Math.min(
      ...ringOf(map, 'p').map((c) => map.crs.distance([c[0]!, c[1]!], target)),
    )
    // Landed *exactly* on the neighbour's corner, not merely close to the pointer.
    expect(nearest).toBeLessThan(0.002)

    map.destroy()
  })

  it('the neighbour is untouched — snapping to a corner does not move the thing snapped to', async () => {
    const map = await makeMap(true)
    const before = JSON.stringify(ringOf(map, 'q'))

    map.test.drag(SE, [32.850595, 39.930004], { steps: 8 })
    await map.test.flush()

    expect(JSON.stringify(ringOf(map, 'q'))).toEqual(before)
    map.destroy()
  })
})
