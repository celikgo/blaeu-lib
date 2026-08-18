/**
 * `DrawApi.cancel()` must actually cancel.
 *
 * The defect: `cancel()` called `session.cancel()`, which clears the session's vertices and
 * preview and emits `draw:cancel` — but a single-gesture tool also holds an **anchor in its own
 * closure** (the rectangle's `origin`, the circle's `centre`, freehand's `tracing`) that the
 * session cannot reach. So the pending `pointerup` still ran its commit path: a feature written
 * *after* the application had been told the drawing was abandoned.
 *
 * `disable()` never had this problem, because it deactivates the tool and `deactivate()` clears
 * the anchor — which is exactly why draw was cited as the well-behaved sibling while edit was
 * not. The fix gives the tool contract an `abort()` so a cancel can reach the anchor without
 * tearing the tool down.
 */
import { describe, expect, it } from 'vitest'
import { ANKARA, createTestMap, offsetMetres, type TestMap } from '@blaeu/core/testing'

import { drawPlugin } from './index.js'

const A = ANKARA
const B = offsetMetres(ANKARA, 40, 30)

const drawMap = (): Promise<TestMap> =>
  createTestMap({ plugins: [drawPlugin({ collection: 'parcels' })] })

const stored = (map: TestMap): number => map.store.collection('parcels').size

describe('DrawApi.cancel() reaches the tool, not just the session', () => {
  it('a cancelled rectangle does not commit on the pending pointerup', async () => {
    const map = await drawMap()
    map.plugin('draw').start('rectangle')

    map.test.pointerDown(A)
    map.test.pointerMove(B)
    map.plugin('draw').cancel()
    // The release the user was always going to make. Before `abort()`, this committed.
    map.test.pointerUp(B)
    await map.test.flush()

    expect(stored(map)).toBe(0)
    await map.destroy()
  })

  it('a cancelled circle does not commit on the pending pointerup', async () => {
    const map = await drawMap()
    map.plugin('draw').start('circle')

    map.test.pointerDown(A)
    map.test.pointerMove(B)
    map.plugin('draw').cancel()
    map.test.pointerUp(B)
    await map.test.flush()

    expect(stored(map)).toBe(0)
    await map.destroy()
  })

  it('a cancelled freehand trace does not commit on the pending pointerup', async () => {
    const map = await drawMap()
    map.plugin('draw').start('freehand')

    map.test.pointerDown(A)
    map.test.pointerMove(offsetMetres(ANKARA, 10, 10))
    map.test.pointerMove(B)
    map.plugin('draw').cancel()
    map.test.pointerUp(B)
    await map.test.flush()

    expect(stored(map)).toBe(0)
    await map.destroy()
  })

  it('announces draw:cancel exactly once, not once per owner', async () => {
    const map = await drawMap()
    let cancels = 0
    map.events.on('draw:cancel', () => {
      cancels += 1
    })

    map.plugin('draw').start('rectangle')
    map.test.pointerDown(A)
    map.test.pointerMove(B)
    map.plugin('draw').cancel()
    map.test.pointerUp(B)
    await map.test.flush()

    // The tool owns its anchor, the session owns the vertices and the event. One each.
    expect(cancels).toBe(1)
    await map.destroy()
  })

  it('the tool stays usable — the next rectangle draws normally', async () => {
    const map = await drawMap()
    map.plugin('draw').start('rectangle')

    map.test.pointerDown(A)
    map.plugin('draw').cancel()
    map.test.pointerUp(B)
    await map.test.flush()
    expect(stored(map)).toBe(0)

    // Cancelling abandons the shape, not the tool: `deactivate` was never called.
    expect(map.tools.active).toBe('draw:rectangle')
    map.test.pointerDown(A)
    map.test.pointerMove(B)
    map.test.pointerUp(B)
    await map.test.flush()

    expect(stored(map)).toBe(1)
    await map.destroy()
  })

  it('cancelling a multi-click polygon still works — its state is all in the session', async () => {
    const map = await drawMap()
    map.plugin('draw').start('polygon')

    map.test.click(A)
    map.test.click(offsetMetres(ANKARA, 40, 0))
    map.test.click(B)
    map.plugin('draw').cancel()
    await map.test.flush()

    expect(map.plugin('draw').vertices).toEqual([])
    expect(stored(map)).toBe(0)
    await map.destroy()
  })
})
