import { describe, expect, it } from 'vitest'
import { createTestMap } from '../testing/index.js'
import { parcelFixture } from '../testing/fixtures.js'
import { twitterDim } from './themes/index.js'

/**
 * The wire that makes `theme.basemap` live rather than dead config.
 *
 * These go through the real map and assert on the `FakeRenderer`, which models the
 * *net* effect of a MapLibre `setStyle` — the basemap changes and the sources
 * survive. If this passes against the fake and fails in a browser, the
 * re-materialisation in `MapLibreRenderer.setBasemap` is the thing to look at.
 */
describe('theme → basemap wiring', () => {
  it('leaves the basemap alone for the default, basemap-less theme', async () => {
    const map = await createTestMap()
    // The default keeps the blank-canvas philosophy — no ground colour is forced,
    // so nothing is pushed to the renderer.
    expect(map.test.renderer.setBasemapCalls).toBe(0)
    await map.destroy()
  })

  it('pushes a theme basemap to the renderer, and the data survives the swap', async () => {
    const map = await createTestMap({ features: { parcels: [parcelFixture('a')] } })
    expect(map.store.collection('parcels').size).toBe(1)

    map.theme.use('twitter-dim')

    // The swap reached the renderer with the dark theme's ground.
    expect(map.test.renderer.setBasemapCalls).toBe(1)
    expect(map.test.renderer.basemap).toBe(twitterDim.basemap)
    // The feature is still there — a theme change must not wipe the map.
    expect(map.store.collection('parcels').size).toBe(1)

    await map.destroy()
  })

  it('re-applies on each switch but not for an unchanged basemap', async () => {
    const map = await createTestMap()

    map.theme.use('twitter-light')
    map.theme.use('twitter-dim')
    expect(map.test.renderer.setBasemapCalls).toBe(2)
    expect(map.test.renderer.basemap).toBe(twitterDim.basemap)

    // Re-selecting the same theme is a no-op for the ground: the basemap reference is
    // unchanged, so we do not pay for a redundant restyle.
    map.theme.use('twitter-dim')
    expect(map.test.renderer.setBasemapCalls).toBe(2)

    await map.destroy()
  })
})
