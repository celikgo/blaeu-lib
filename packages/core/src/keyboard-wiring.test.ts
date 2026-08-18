/**
 * The keyboard reaches tools through the kernel, not around it.
 *
 * `InteractionContext` has had a `'keydown'` kind and a `key` field since the beginning,
 * `dispatchToTool` has always routed it, and ten tools across five packages implement
 * `onKeyDown` — but **no renderer ever produced one**. Three READMEs documented Escape and
 * Backspace, `plugin-history` gave up and bound its own DOM listener, and the only thing that
 * made any of it work was `map.test.key()`, which built the context itself and walked it into
 * the pipeline by hand. So the harness tested a path that did not exist in production.
 *
 * `Renderer.onKey` closes that. These tests assert the wiring end to end: the renderer's key
 * event becomes an `InteractionContext` that middleware sees and the active tool receives.
 */
import { describe, expect, it } from 'vitest'
import { createTestMap } from './testing/createTestMap.js'
import type { InteractionContext } from './types/pipeline.js'
import type { Tool } from './types/extensions.js'
import type { LngLat } from './types/common.js'

/** A tool that records every key it is handed. */
function recordingTool(log: InteractionContext[]): Tool {
  return {
    id: 'probe',
    activate: () => {},
    deactivate: () => {},
    onKeyDown(ctx) {
      log.push(ctx)
    },
  }
}

describe('a key press reaches the active tool', () => {
  it('arrives with the kind and the key set', async () => {
    const seen: InteractionContext[] = []
    const map = await createTestMap({})
    map.tools.register('probe', recordingTool(seen))
    map.tools.activate('probe')

    map.test.key('Escape')

    expect(seen).toHaveLength(1)
    expect(seen[0]!.kind).toBe('keydown')
    expect(seen[0]!.key).toBe('Escape')
    await map.destroy()
  })

  it('carries the modifiers', async () => {
    const seen: InteractionContext[] = []
    const map = await createTestMap({})
    map.tools.register('probe', recordingTool(seen))
    map.tools.activate('probe')

    map.test.key('z', { ctrl: true })

    expect(seen[0]!.key).toBe('z')
    expect(seen[0]!.modifiers.ctrl).toBe(true)
    expect(seen[0]!.modifiers.shift).toBe(false)
    await map.destroy()
  })

  it('reports button -1, because no button was pressed', async () => {
    const seen: InteractionContext[] = []
    const map = await createTestMap({})
    map.tools.register('probe', recordingTool(seen))
    map.tools.activate('probe')

    map.test.key('Escape')

    // 0 would mean the *primary* button, and a tool branching on `button === 0` must not
    // mistake a key press for a left click.
    expect(seen[0]!.button).toBe(-1)
    await map.destroy()
  })

  it('is positioned where the pointer last was', async () => {
    const seen: InteractionContext[] = []
    const map = await createTestMap({})
    map.tools.register('probe', recordingTool(seen))
    map.tools.activate('probe')

    const at: LngLat = [32.86, 39.94]
    map.test.pointerMove(at)
    map.test.key('Backspace')

    // A key event has no position of its own, but `InteractionContext` promises tools one.
    expect(seen[0]!.lngLat[0]).toBeCloseTo(at[0], 6)
    expect(seen[0]!.lngLat[1]).toBeCloseTo(at[1], 6)
    await map.destroy()
  })

  it('runs through the interaction pipeline before the tool sees it', async () => {
    const seen: InteractionContext[] = []
    const order: string[] = []
    const map = await createTestMap({})
    map.interaction.use((ctx, next) => {
      if (ctx.kind === 'keydown') order.push('middleware')
      next()
    })
    map.tools.register('probe', {
      id: 'probe',
      activate: () => {},
      deactivate: () => {},
      onKeyDown(ctx) {
        order.push('tool')
        seen.push(ctx)
      },
    })
    map.tools.activate('probe')

    map.test.key('Escape')

    // The same ordering a click gets — which is what makes `onKeyDown` a real handler.
    expect(order).toEqual(['middleware', 'tool'])
    await map.destroy()
  })

  it('a middleware that consumes it stops the tool from seeing it', async () => {
    const seen: InteractionContext[] = []
    const map = await createTestMap({})
    map.interaction.use((ctx, next) => {
      if (ctx.kind === 'keydown') ctx.consume()
      next()
    })
    map.tools.register('probe', recordingTool(seen))
    map.tools.activate('probe')

    map.test.key('Escape')

    expect(seen).toEqual([])
    await map.destroy()
  })

  it('stops arriving once the map is destroyed', async () => {
    const seen: InteractionContext[] = []
    const map = await createTestMap({})
    map.tools.register('probe', recordingTool(seen))
    map.tools.activate('probe')

    const renderer = map.test.renderer
    await map.destroy()
    renderer.emitKey('Escape')

    expect(seen).toEqual([])
  })
})
