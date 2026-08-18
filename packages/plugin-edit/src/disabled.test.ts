/**
 * A disabled plugin does not edit.
 *
 * This is the *fourth* test every plugin owes, and the one the testing skill did not ask for.
 * It mandates degradation (works without its optional deps), teardown (destroy leaves nothing
 * behind) and undo round-trip — but not `disable`. So nobody wrote it, and `editPlugin.disable`
 * shipped as `ctx.tryPlugin('edit')?.stop()`: it ended the *session* and left `edit:vertex`
 * **active**. The next pointerdown ran the vertex tool's own handler, which calls
 * `controller.edit(featureAt(...))` — re-activating the tool and re-entering editing. A corner
 * drag then moved stored geometry after `plugin:disabled` had already fired.
 *
 * A host building a read-only viewer mode out of `plugins.disable` was getting a writable map.
 */
import { describe, expect, it } from 'vitest'
import {
  ANKARA,
  createTestMap,
  offsetMetres,
  parcelFixture,
  type TestMap,
} from '@blaeu/core/testing'
import type { FeatureId, LngLat, Polygon } from '@blaeu/core'

import { editPlugin } from './index.js'

const PARCEL_W = 50
const PARCEL_H = 40
const SW = ANKARA
const NE = offsetMetres(ANKARA, PARCEL_W, PARCEL_H)

const mapWithParcel = (): Promise<TestMap> =>
  createTestMap({ plugins: [editPlugin()], features: { parcels: [parcelFixture('p')] } })

function corners(map: TestMap, id: FeatureId): LngLat[] {
  const polygon = map.store.find(id)!.geometry as Polygon
  return (polygon.coordinates[0] ?? []).slice(0, -1).map((p) => [p[0]!, p[1]!] as LngLat)
}

describe('editPlugin.disable()', () => {
  it('deactivates the edit tool instead of leaving it live', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')
    expect(map.tools.active).toBe('edit:vertex')

    map.plugins.disable('edit')

    // The whole defect in one assertion: this used to still be 'edit:vertex'.
    expect(map.tools.active).toBeNull()
    await map.destroy()
  })

  it('does not move geometry when a corner is dragged after disabling', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')
    map.plugins.disable('edit')

    const before = corners(map, 'p')
    // The gesture that used to work: press on the NE corner, drag it 20 m away, release.
    map.test.drag(NE, offsetMetres(NE, 20, 20))
    await map.test.flush()

    expect(corners(map, 'p')).toEqual(before)
    await map.destroy()
  })

  it('refuses to start a new session on a click, so the front door stays shut', async () => {
    const map = await mapWithParcel()
    map.plugins.disable('edit')

    map.test.click(offsetMetres(SW, PARCEL_W / 2, PARCEL_H / 2))
    await map.test.flush()

    expect(map.plugin('edit').editing).toBeNull()
    expect(map.tools.active).toBeNull()
    await map.destroy()
  })

  it('refuses even when the host re-activates the tool by hand', async () => {
    const map = await mapWithParcel()
    map.plugins.disable('edit')

    // Deactivating the tool closes the front door; the controller's own gate closes it from
    // the inside. Without the gate, this reopens editing on a disabled plugin.
    map.tools.activate('edit:vertex')
    const before = corners(map, 'p')
    map.test.drag(NE, offsetMetres(NE, 20, 20))
    await map.test.flush()

    expect(map.plugin('edit').editing).toBeNull()
    expect(corners(map, 'p')).toEqual(before)
    await map.destroy()
  })

  it('re-enabling restores editing without re-installing anything', async () => {
    const map = await mapWithParcel()
    map.plugins.disable('edit')
    map.plugins.enable('edit')

    map.plugin('edit').edit('p')
    expect(map.plugin('edit').editing).toBe('p')
    expect(map.tools.active).toBe('edit:vertex')

    const before = corners(map, 'p')
    map.test.drag(NE, offsetMetres(NE, 20, 20))
    await map.test.flush()

    // Dormant, not destroyed: the tools were never unregistered, so editing just works again.
    expect(corners(map, 'p')).not.toEqual(before)
    await map.destroy()
  })

  it('ends the session it was in the middle of', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')
    expect(map.plugin('edit').editing).toBe('p')

    map.plugins.disable('edit')
    expect(map.plugin('edit').editing).toBeNull()
    await map.destroy()
  })
})
