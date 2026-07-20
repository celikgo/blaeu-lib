import { describe, expect, it } from 'vitest'
import { createTestMap } from './testing/index.js'

/**
 * The wire that makes `config.interaction` live rather than dead config.
 *
 * `scrollZoom`, `dragPan`, `doubleClickZoom` and `keyboard` are resolved from the host's
 * options, the preset, and the defaults — and for a long while nothing read the result, so a
 * host that turned scroll-zoom off (an embedded map on a scrolling page) or a preset that turned
 * double-click-zoom off (double-click closes a ring) got no effect. These go through the real map
 * and assert on the `FakeRenderer`, which records the config the kernel handed it. If this passes
 * against the fake and fails in a browser, `MapLibreRenderer.applyInteraction` is the thing to
 * look at.
 */
describe('config → interaction wiring', () => {
  it('hands the resolved interaction config to the renderer after mount', async () => {
    const map = await createTestMap()
    // The whole resolved block reaches the renderer — the defaults, unremarkable but present,
    // are what a bare boolean flag being ignored would have left undefined.
    expect(map.test.renderer.interaction).toBeDefined()
    expect(map.test.renderer.interaction?.doubleClickZoom).toBe(true)
    expect(map.test.renderer.interaction?.scrollZoom).toBe(true)
    await map.destroy()
  })

  it('carries a host override through to the renderer', async () => {
    const map = await createTestMap({ config: { interaction: { scrollZoom: false } } })
    // The one the host turned off is off...
    expect(map.test.renderer.interaction?.scrollZoom).toBe(false)
    // ...and the rest keep their resolved defaults rather than vanishing.
    expect(map.test.renderer.interaction?.dragPan).toBe(true)
    expect(map.test.renderer.interaction?.keyboard).toBe(true)
    await map.destroy()
  })

  it('carries a preset override through to the renderer', async () => {
    // A preset that closes rings on double-click must be able to stop the map zooming on it.
    const map = await createTestMap({
      preset: { id: 'ring-drawer', config: { interaction: { doubleClickZoom: false } } },
    })
    expect(map.test.renderer.interaction?.doubleClickZoom).toBe(false)
    await map.destroy()
  })
})
