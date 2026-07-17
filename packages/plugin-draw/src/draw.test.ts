import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestMap, expectWithinMetres, offsetMetres, ANKARA } from '@blaeu/core/testing'
import type { TestMap } from '@blaeu/core/testing'
import type { Command, FeatureId, BlaeuPlugin, LngLat, Polygon } from '@blaeu/core'

import {
  CIRCLE_CENTRE_PROPERTY,
  CIRCLE_RADIUS_PROPERTY,
  CIRCLE_SHAPE_PROPERTY,
  PREVIEW_COLLECTION,
  PREVIEW_ID,
  PREVIEW_LAYER,
  drawPlugin,
} from './index.js'

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

const A: LngLat = ANKARA
const B: LngLat = offsetMetres(ANKARA, 40, 0)
const C: LngLat = offsetMetres(ANKARA, 40, 30)

/** Records what the history plugin would record — i.e. everything not marked transient. */
function recordCommands(map: TestMap): Command[] {
  const recorded: Command[] = []
  map.commands.onDidExecute((command) => recorded.push(command))
  return recorded
}

/**
 * Draws a triangle with the polygon tool: three clicks and a double-click to close.
 *
 * The double-click hands the shape to the tool, which fires the commit and does not
 * await it, so the store write lands on a later macrotask. Flushing here means every
 * caller can assert on the store the line after it draws.
 */
async function drawTriangle(map: TestMap): Promise<void> {
  map.plugin('draw').start('polygon')
  map.test.click(A)
  map.test.click(B)
  map.test.click(C)
  map.test.dblClick(C)
  await map.test.flush()
}

/**
 * A stand-in for `@blaeu/plugin-snap`.
 *
 * This package may not import the real one (boundary rule 2), so the handshake is
 * structural and nothing checks it at compile time. That makes the *names* below
 * load-bearing: they are `SnapApi.setInProgress` and `SnapApi.exclude`, exactly as
 * `@blaeu/plugin-snap` declares them. A fake that invents its own names would pass
 * while the real integration silently did nothing — which is precisely the bug this test
 * exists to catch, so the fake must not be allowed to be more forgiving than reality.
 */
interface FakeSnap {
  inProgress: readonly LngLat[]
  excluded: readonly FeatureId[]
}

function fakeSnapPlugin(state: FakeSnap): BlaeuPlugin<FakeSnap, unknown> {
  return {
    id: 'snap',
    version: '1.0.0',
    setup: () =>
      Object.assign(state, {
        setInProgress: (vertices: readonly LngLat[]) => {
          state.inProgress = [...vertices]
        },
        exclude: (ids: Iterable<FeatureId>) => {
          state.excluded = [...ids]
        },
      }),
  }
}

/* ------------------------------------------------------------------------- */
/* The three tests every plugin owes                                          */
/* ------------------------------------------------------------------------- */

describe('the three tests every plugin owes', () => {
  it('degrades: draws with neither the snap nor the history plugin present', async () => {
    const map = await createTestMap({ plugins: [drawPlugin()] })

    await drawTriangle(map)

    expect(map.store.collection('default').size).toBe(1)
    const [feature] = map.store.collection('default').all()
    expect(feature?.geometry.type).toBe('Polygon')
    // Closed on ingest: three corners plus the repeated first one.
    expect((feature?.geometry as Polygon).coordinates[0]).toHaveLength(4)
  })

  it('leaks nothing on removal', async () => {
    const map = await createTestMap()
    const baseline = map.debug.snapshot()

    await map.use(drawPlugin({ defaultMode: 'polygon' }))
    map.test.click(A)
    map.test.click(B)

    await map.remove('draw')

    expect(map.debug.snapshot()).toEqual(baseline)
    expect(map.debug.snapshot()).toMatchObject({ plugins: 0, features: 0, layers: 0 })
    expect(map.tools.list()).toEqual([])
    expect(map.store.collections()).not.toContain(PREVIEW_COLLECTION)
  })

  it('round-trips through undo to deep equality', async () => {
    const map = await createTestMap({ plugins: [drawPlugin()] })
    const recorded = recordCommands(map)

    const before = map.store.snapshot()
    await drawTriangle(map)
    expect(map.store.snapshot()).not.toEqual(before)

    // What a history plugin does. `_apply` is the same entry point it uses; this package
    // must not import it (boundary rule 2), and does not need to.
    expect(recorded).toHaveLength(1)
    map.commands._apply(recorded[0]!, 'undo')

    expect(map.store.snapshot()).toEqual(before)
  })
})

/* ------------------------------------------------------------------------- */
/* The preview must never reach the undo stack                                */
/* ------------------------------------------------------------------------- */

describe('the preview', () => {
  it('is transient — one polygon is one undo step, not one per vertex', async () => {
    const map = await createTestMap({ plugins: [drawPlugin()] })
    const recorded = recordCommands(map)

    map.plugin('draw').start('polygon')
    map.test.click(A)
    map.test.pointerMove(B)
    map.test.click(B)
    map.test.pointerMove(C)
    map.test.click(C)
    // Every one of those moves rewrote the rubber band. None of them may be recorded.
    expect(recorded).toHaveLength(0)

    map.test.dblClick(C)
    await map.test.flush()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.type).toBe('core:add-features')
  })

  it('lives in its own collection and is cleared when the shape completes', async () => {
    const map = await createTestMap({ plugins: [drawPlugin()] })

    map.plugin('draw').start('polygon')
    map.test.click(A)
    map.test.pointerMove(B)
    expect(map.store.collection(PREVIEW_COLLECTION).size).toBe(1)
    expect(map.store.collection('default').size).toBe(0)

    map.test.click(B)
    map.test.click(C)
    map.test.dblClick(C)
    await map.test.flush()

    expect(map.store.collection(PREVIEW_COLLECTION).size).toBe(0)
    expect(map.store.collection('default').size).toBe(1)
  })
})

/* ------------------------------------------------------------------------- */
/* Modes                                                                      */
/* ------------------------------------------------------------------------- */

describe('point', () => {
  it('commits one point per click', async () => {
    const map = await createTestMap({ plugins: [drawPlugin({ defaultMode: 'point' })] })

    map.test.click(A)
    map.test.click(B)
    await map.test.flush()

    expect(map.store.collection('default').size).toBe(2)
    expect(map.store.collection('default').all()[0]?.geometry.type).toBe('Point')
  })
})

describe('line and polygon', () => {
  let map: TestMap

  beforeEach(async () => {
    map = await createTestMap({ plugins: [drawPlugin()] })
  })

  it('closes a polygon by clicking its first vertex', async () => {
    map.plugin('draw').start('polygon')
    map.test.click(A)
    map.test.click(B)
    map.test.click(C)
    map.test.click(A)
    await map.test.flush()

    expect(map.store.collection('default').size).toBe(1)
    expect(map.plugin('draw').vertices).toEqual([])
  })

  it('does not close a line on its first vertex — a line is not a ring', async () => {
    map.plugin('draw').start('line')
    map.test.click(A)
    map.test.click(B)
    map.test.click(A)
    // Flush before asserting *absence*: without it a stray commit would land after the
    // assertion and the test would pass by being early rather than by being right.
    await map.test.flush()

    expect(map.store.collection('default').size).toBe(0)
    expect(map.plugin('draw').vertices).toHaveLength(3)
  })

  it('takes the last vertex back on Backspace', () => {
    map.plugin('draw').start('polygon')
    map.test.click(A)
    map.test.click(B)
    map.test.click(C)
    map.test.key('Backspace')

    expect(map.plugin('draw').vertices).toHaveLength(2)
  })

  it('abandons the shape on Escape, and stays armed for the next one', async () => {
    const cancelled = vi.fn()
    map.events.on('draw:cancel', (e) => cancelled(e.payload.mode))

    map.plugin('draw').start('polygon')
    map.test.click(A)
    map.test.click(B)
    map.test.key('Escape')

    expect(cancelled).toHaveBeenCalledWith('polygon')
    expect(map.plugin('draw').vertices).toEqual([])
    expect(map.store.collection(PREVIEW_COLLECTION).size).toBe(0)
    expect(map.plugin('draw').active).toBe('polygon')

    await drawTriangle(map)
    expect(map.store.collection('default').size).toBe(1)
  })

  it('refuses a polygon with fewer than three distinct corners', async () => {
    map.plugin('draw').start('polygon')
    map.test.click(A)
    map.test.click(B)
    map.test.dblClick(B)
    await map.test.flush()

    expect(map.store.collection('default').size).toBe(0)
  })

  it('finishes from the API, as a toolbar button would', async () => {
    const draw = map.plugin('draw')
    draw.start('line')
    map.test.click(A)
    map.test.click(B)
    draw.finish()
    await map.test.flush()

    expect(map.store.collection('default').size).toBe(1)
    expect(map.store.collection('default').all()[0]?.geometry.type).toBe('LineString')
  })
})

describe('rectangle', () => {
  it('is axis-aligned in the working CRS, not in lng/lat', async () => {
    const map = await createTestMap({ plugins: [drawPlugin({ defaultMode: 'rectangle' })] })

    const corner = offsetMetres(ANKARA, 60, 45)
    map.test.drag(ANKARA, corner)
    await map.test.flush()

    const [feature] = map.store.collection('default').all()
    const ring = (feature?.geometry as Polygon).coordinates[0]!
    expect(ring).toHaveLength(5)

    const plane = map.crs.working
    const xy = ring.slice(0, 4).map((p) => plane.forward([p[0]!, p[1]!]))
    const xs = [...new Set(xy.map((p) => round(p[0])))]
    const ys = [...new Set(xy.map((p) => round(p[1])))]

    // Exactly two distinct eastings and two distinct northings *in the plane*. A rectangle
    // built by holding lng and lat constant would also pass a naive "4 corners" check while
    // being a trapezoid on the ground — this is the assertion that catches it.
    expect(xs).toHaveLength(2)
    expect(ys).toHaveLength(2)

    // And the corners really are the ones the user dragged between.
    expectWithinMetres(cornerNearest(ring, ANKARA), ANKARA, 0.01)
    expectWithinMetres(cornerNearest(ring, corner), corner, 0.01)
  })

  it('draws nothing when the drag has no area', async () => {
    const map = await createTestMap({ plugins: [drawPlugin({ defaultMode: 'rectangle' })] })

    map.test.pointerDown(ANKARA)
    map.test.pointerUp(ANKARA)
    await map.test.flush()

    expect(map.store.collection('default').size).toBe(0)
    expect(map.store.collection(PREVIEW_COLLECTION).size).toBe(0)
  })
})

describe('circle', () => {
  it('stores the true centre and radius so it can be re-edited losslessly', async () => {
    const map = await createTestMap({
      plugins: [drawPlugin({ defaultMode: 'circle', circleSegments: 32 })],
    })

    const edge = offsetMetres(ANKARA, 25, 0)
    map.test.drag(ANKARA, edge)
    await map.test.flush()

    const [feature] = map.store.collection('default').all()
    expect(feature?.geometry.type).toBe('Polygon')
    expect(feature?.properties[CIRCLE_SHAPE_PROPERTY]).toBe('circle')

    // The radius is a *planar* distance in the working CRS — the number a surveyor would
    // dimension — not a great-circle distance on a sphere.
    const expected = map.crs.distance(ANKARA, edge)
    expect(feature?.properties[CIRCLE_RADIUS_PROPERTY]).toBeCloseTo(expected, 6)
    expect(feature?.properties[CIRCLE_CENTRE_PROPERTY]).toEqual([ANKARA[0], ANKARA[1]])

    const ring = (feature?.geometry as Polygon).coordinates[0]!
    // 32 segments, plus the repeated closing vertex.
    expect(ring).toHaveLength(33)

    // Every vertex sits on the circle, to within the 1 mm precision grid.
    const plane = map.crs.working
    const [cx, cy] = plane.forward(ANKARA)
    for (const p of ring) {
      const [x, y] = plane.forward([p[0]!, p[1]!])
      expect(Math.hypot(x - cx, y - cy)).toBeCloseTo(expected, 2)
    }
  })
})

describe('freehand', () => {
  it('simplifies the trace — a raw trace is not a geometry', async () => {
    const map = await createTestMap({
      plugins: [drawPlugin({ defaultMode: 'freehand', freehandTolerance: 0.5 })],
    })

    // A straight-ish trace, sampled 60 times. Douglas-Peucker should keep almost none of it.
    map.test.drag(ANKARA, offsetMetres(ANKARA, 120, 0), { steps: 60 })
    await map.test.flush()

    const [feature] = map.store.collection('default').all()
    expect(feature?.geometry.type).toBe('LineString')

    const drawn = map.plugin('draw').vertices
    expect(drawn).toEqual([])

    const coordinates = (feature?.geometry as { coordinates: number[][] }).coordinates
    expect(coordinates.length).toBeGreaterThanOrEqual(2)
    expect(coordinates.length).toBeLessThan(10)
  })

  it('keeps the corners of an L-shaped trace', async () => {
    const map = await createTestMap({
      plugins: [drawPlugin({ defaultMode: 'freehand', freehandTolerance: 0.5 })],
    })

    const draw = map.plugin('draw')
    expect(draw.active).toBe('freehand')

    map.test.pointerDown(ANKARA)
    for (let i = 1; i <= 20; i++) map.test.pointerMove(offsetMetres(ANKARA, i * 5, 0))
    for (let i = 1; i <= 20; i++) map.test.pointerMove(offsetMetres(ANKARA, 100, i * 5))
    map.test.pointerUp(offsetMetres(ANKARA, 100, 100))
    await map.test.flush()

    const [feature] = map.store.collection('default').all()
    const coordinates = (feature?.geometry as { coordinates: number[][] }).coordinates
    // Start, corner, end — the corner is the one vertex Douglas-Peucker must not drop.
    expect(coordinates.length).toBeGreaterThanOrEqual(3)
    expect(coordinates.length).toBeLessThan(10)
    expectWithinMetres(
      [coordinates[coordinates.length - 1]![0]!, coordinates[coordinates.length - 1]![1]!],
      offsetMetres(ANKARA, 100, 100),
      0.01,
    )
  })
})

/* ------------------------------------------------------------------------- */
/* Hooks, events, options                                                     */
/* ------------------------------------------------------------------------- */

describe('before:draw:complete', () => {
  it('vetoes the shape, and leaves nothing behind', async () => {
    const map = await createTestMap({ plugins: [drawPlugin()] })
    const recorded = recordCommands(map)
    const cancelled = vi.fn()

    map.events.onBefore('before:draw:complete', (e) =>
      e.preventDefault('parcel overlaps parcel 12'),
    )
    map.events.on('draw:cancel', (e) => cancelled(e.payload.reason))

    await drawTriangle(map)

    expect(map.store.collection('default').size).toBe(0)
    expect(map.store.collection(PREVIEW_COLLECTION).size).toBe(0)
    expect(recorded).toHaveLength(0)
    expect(cancelled).toHaveBeenCalledWith('parcel overlaps parcel 12')
  })

  it('sees the geometry and the target collection before the store does', async () => {
    const map = await createTestMap({ plugins: [drawPlugin()] })
    const seen = vi.fn()

    map.events.onBefore('before:draw:complete', (e) =>
      seen(e.payload.mode, e.payload.collection, e.payload.feature.geometry.type),
    )
    await drawTriangle(map)

    expect(seen).toHaveBeenCalledWith('polygon', 'default', 'Polygon')
  })
})

describe('events', () => {
  it('emits start, vertex and complete', async () => {
    const map = await createTestMap({ plugins: [drawPlugin()] })
    const started = vi.fn()
    const vertex = vi.fn()
    const completed = vi.fn()

    map.events.on('draw:start', (e) => started(e.payload.mode))
    map.events.on('draw:vertex', (e) => vertex(e.payload.vertices.length))
    map.events.on('draw:complete', (e) => completed(e.payload.feature.id))

    await drawTriangle(map)

    expect(started).toHaveBeenCalledWith('polygon')
    expect(vertex).toHaveBeenCalledTimes(3)
    expect(vertex).toHaveBeenLastCalledWith(3)
    expect(completed).toHaveBeenCalledTimes(1)
    const [id] = completed.mock.calls[0] as [string]
    expect(map.store.find(id)?.meta.source).toBe('draw')
  })
})

describe('options', () => {
  it('stamps the configured properties on every shape', async () => {
    let n = 0
    const map = await createTestMap({
      plugins: [drawPlugin({ properties: () => ({ ada: '12', n: ++n }) })],
    })

    await drawTriangle(map)
    await drawTriangle(map)

    const [first, second] = map.store.collection('default').all()
    expect(first?.properties['ada']).toBe('12')
    expect(first?.properties['n']).toBe(1)
    expect(second?.properties['n']).toBe(2)
  })

  it('targets the configured collection, and retargets on setCollection', async () => {
    const map = await createTestMap({ plugins: [drawPlugin({ collection: 'parcels' })] })

    await drawTriangle(map)
    expect(map.store.collection('parcels').size).toBe(1)

    map.plugin('draw').setCollection('buildings')
    await drawTriangle(map)
    expect(map.store.collection('buildings').size).toBe(1)
    expect(map.store.collection('parcels').size).toBe(1)
  })
})

/* ------------------------------------------------------------------------- */
/* The snap handshake — one-way, optional, and never an import                */
/* ------------------------------------------------------------------------- */

describe('the snap handshake', () => {
  it('tells a snap plugin what is in progress and what to exclude', async () => {
    const snap: FakeSnap = { inProgress: [], excluded: [] }
    const map = await createTestMap({ plugins: [drawPlugin(), fakeSnapPlugin(snap)] })

    map.plugin('draw').start('polygon')
    map.test.click(A)
    map.test.click(B)

    // The engine can only offer "close the ring on its own first corner" if it knows the
    // corners — and they are not in the store yet, so nobody but the draw plugin can tell it.
    expect(snap.inProgress).toHaveLength(2)
    expectWithinMetres(snap.inProgress[0]!, A, 0.01)
    // And the rubber band must not be a snap target for the pointer dragging it: the preview
    // feature is in the store, at distance zero from the cursor, and would win every query.
    expect(snap.excluded).toEqual([PREVIEW_ID])

    map.test.click(C)
    map.test.dblClick(C)
    // The session clears its vertices and re-syncs snap only *after* the commit resolves.
    await map.test.flush()
    expect(snap.inProgress).toEqual([])
  })

  it('warns rather than no-ops when a snap plugin does not answer to the handshake', async () => {
    const warn = vi.fn()
    const strangeSnap: BlaeuPlugin<Record<string, never>, unknown> = {
      id: 'snap',
      version: '1.0.0',
      setup: () => ({}),
    }
    const map = await createTestMap({
      plugins: [drawPlugin(), strangeSnap],
      config: { logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } },
    })

    map.plugin('draw').start('polygon')
    map.test.click(A)

    // Drawing still works — the dependency is genuinely optional...
    map.test.click(B)
    map.test.click(C)
    map.test.dblClick(C)
    await map.test.flush()
    expect(map.store.collection('default').size).toBe(1)

    // ...but an incompatible snap plugin is a bug, not a degradation, and it says so once.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('setInProgress()')
  })
})

describe('the preview layer', () => {
  const lineColorOf = (map: TestMap): unknown =>
    map.test.renderer.layers.get(PREVIEW_LAYER)?.style.line?.color

  it('registers a themed layer over the preview collection by default', async () => {
    const map = await createTestMap({ plugins: [drawPlugin()] })
    // Without this the rubber band was invisible under every preset — the collection
    // existed, but nothing drew it.
    const layer = map.layers.get(PREVIEW_LAYER)
    expect(layer?.type).toBe('vector')
    // Styled from the tokens, not a hardcoded colour.
    expect(lineColorOf(map)).toBe(map.theme.token('color').accent)
    await map.destroy()
  })

  it('re-tints the rubber band when the theme changes', async () => {
    const map = await createTestMap({ plugins: [drawPlugin()] })
    const before = lineColorOf(map)

    map.theme.use('twitter-dim')

    const after = lineColorOf(map)
    expect(after).not.toBe(before)
    expect(after).toBe(map.theme.token('color').accent)
    await map.destroy()
  })

  it('can be turned off for an app that declares its own preview layer', async () => {
    const map = await createTestMap({ plugins: [drawPlugin({ previewLayer: false })] })
    expect(map.layers.get(PREVIEW_LAYER)).toBeUndefined()
    await map.destroy()
  })
})

/* ------------------------------------------------------------------------- */

function round(value: number): number {
  // The store quantises to the 1 mm grid; comparing raw floats would make "the same easting"
  // depend on the last bit of a projection round-trip.
  return Math.round(value * 1000) / 1000
}

function cornerNearest(ring: readonly number[][], target: LngLat): LngLat {
  let best: LngLat = [ring[0]![0]!, ring[0]![1]!]
  let bestDistance = Infinity
  for (const p of ring) {
    const candidate: LngLat = [p[0]!, p[1]!]
    const distance = Math.hypot(candidate[0] - target[0], candidate[1] - target[1])
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}
