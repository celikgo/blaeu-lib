import { describe, expect, it } from 'vitest'
import {
  AddFeaturesCommand,
  distanceToSegment,
  type FeatureInput,
  type InteractionContext,
  type LngLat,
  type Polygon,
  type ProjectedXY,
  type ScreenPoint,
  type SnapResult,
} from '@fleximap/core'
import {
  createTestMap,
  expectWithinMetres,
  parcelFixture,
  type TestMap,
} from '@fleximap/core/testing'
import { snapPlugin } from './index.js'
import { INDICATOR_LAYER, INDICATOR_SOURCE } from './constants.js'
import type { SnapOptions } from './types.js'

/* ========================================================================= */
/* Harness                                                                   */
/* ========================================================================= */

/** What the pipeline handed to the tool: the position *after* snapping ran. */
interface Seen {
  readonly lngLat: LngLat
  readonly rawLngLat: LngLat
  readonly snap: SnapResult | undefined
}

/**
 * Reads the context at the point a tool would read it.
 *
 * Priority 0, so it runs *after* the snap middleware at 100 — which is the only
 * honest place to assert from: it is exactly where the draw tool sits.
 */
function probe(map: TestMap): { readonly last: Seen | undefined; readonly all: readonly Seen[] } {
  const all: Seen[] = []
  map.interaction.use(
    (ctx: InteractionContext, next: () => void) => {
      all.push({ lngLat: ctx.lngLat, rawLngLat: ctx.rawLngLat, snap: ctx.snap })
      next()
    },
    { id: 'test:probe', priority: 0 },
  )
  return {
    get last(): Seen | undefined {
      return all[all.length - 1]
    },
    all,
  }
}

const PARCELS: readonly FeatureInput[] = [parcelFixture('p1')]

async function snapMap(
  options: SnapOptions = {},
  features = { parcels: PARCELS },
): Promise<TestMap> {
  return createTestMap({ plugins: [snapPlugin(options)], features })
}

/** The parcel's corners, as the store holds them — quantised, closed, wound. */
function corners(map: TestMap, id = 'p1'): readonly LngLat[] {
  const feature = map.store.find(id)
  if (feature === undefined) throw new Error(`fixture "${id}" is not in the store`)
  const ring = (feature.geometry as Polygon).coordinates[0]!
  // Drop the closing coordinate: it is the same corner as index 0.
  return ring.slice(0, -1).map((p) => [p[0]!, p[1]!] as LngLat)
}

/** A position `dx`/`dy` **pixels** from `anchor`. Pixels are the only unit a tolerance is in. */
function offsetPx(map: TestMap, anchor: LngLat, dx: number, dy: number): LngLat {
  const screen = map.test.project(anchor)
  return map.test.unproject({ x: screen.x + dx, y: screen.y + dy })
}

function pixelsApart(map: TestMap, a: LngLat, b: LngLat): number {
  const p: ScreenPoint = map.test.project(a)
  const q: ScreenPoint = map.test.project(b)
  return Math.hypot(p.x - q.x, p.y - q.y)
}

function xy(map: TestMap, point: LngLat): ProjectedXY {
  return map.crs.working.forward(point)
}

/* ========================================================================= */
/* The three tests every plugin owes                                         */
/* ========================================================================= */

describe('the three tests every plugin owes', () => {
  it('degrades: it has no dependencies, and works with no other plugin installed', async () => {
    const map = await snapMap()
    const seen = probe(map)

    const corner = corners(map)[0]!
    map.test.pointerMove(offsetPx(map, corner, 4, 0))

    expect(
      map
        .plugin('snap')
        .providers()
        .map((p) => p.id),
    ).toEqual(['vertex', 'intersection', 'midpoint', 'edge', 'extension', 'perpendicular'])
    expect(seen.last?.snap?.candidate.kind).toBe('vertex')
    await map.destroy()
  })

  it('degrades: with every provider turned off it snaps nothing and throws nothing', async () => {
    const map = await snapMap({ providers: [] })
    const seen = probe(map)

    const corner = corners(map)[0]!
    const near = offsetPx(map, corner, 2, 0)
    map.test.pointerMove(near)

    expect(seen.last?.snap).toBeUndefined()
    expect(seen.last?.lngLat).toEqual(near)
    await map.destroy()
  })

  it('leaks nothing on removal', async () => {
    const baseline = await createTestMap({ features: { parcels: PARCELS } })
    const before = baseline.debug.snapshot()

    const map = await snapMap()
    map.test.pointerMove(offsetPx(map, corners(map)[0]!, 3, 0))
    expect(map.test.renderer.layers.has(INDICATOR_LAYER)).toBe(true)
    expect(map.test.renderer.sources.get(INDICATOR_SOURCE)).toHaveLength(1)

    await map.remove('snap')

    expect(map.debug.snapshot()).toEqual(before)
    // The renderer is the other place a plugin leaks, and `debug.snapshot()` cannot
    // see it: an overlay source left behind keeps a copy of every feature on the GPU.
    // (`sources` is not empty — the store's own `parcels` source lives there too.)
    expect(map.test.renderer.sources.has(INDICATOR_SOURCE)).toBe(false)
    expect(map.test.renderer.layers.has(INDICATOR_LAYER)).toBe(false)

    await map.destroy()
    await baseline.destroy()
  })

  it('round-trips a command to deep equality — and leaves no residue of its own in the store', async () => {
    const map = await snapMap()
    const corner = corners(map)[0]!

    // Snap something first: the indicator is live from here on, and if it lived in the
    // store this test would fail — which is precisely why it does not.
    map.test.pointerMove(offsetPx(map, corner, 3, 0))
    expect(map.plugin('snap').current?.candidate.kind).toBe('vertex')

    const before = map.store.snapshot()
    expect(Object.keys(before.collections)).toEqual(['parcels'])

    const command = new AddFeaturesCommand('parcels', [
      { id: 'pin', geometry: { type: 'Point', coordinates: [corner[0], corner[1]] } },
    ])
    expect((await map.commands.commit(command)).ok).toBe(true)
    expect(map.store.snapshot()).not.toEqual(before)

    map.commands._apply(command, 'undo')
    expect(map.store.snapshot()).toEqual(before)

    await map.destroy()
  })

  it('never writes to the store, however much the pointer moves', async () => {
    const map = await snapMap()
    let changes = 0
    map.store.onChange(() => {
      changes++
    })

    const corner = corners(map)[0]!
    for (let i = 0; i < 20; i++) map.test.pointerMove(offsetPx(map, corner, i, 0))
    map.test.click(offsetPx(map, corner, 1, 0))

    expect(changes).toBe(0)
    await map.destroy()
  })
})

/* ========================================================================= */
/* The middleware contract                                                   */
/* ========================================================================= */

describe('the middleware', () => {
  it('rewrites ctx.lngLat before any tool sees it, and leaves rawLngLat alone', async () => {
    const map = await snapMap()
    const seen = probe(map)

    const corner = corners(map)[0]!
    const near = offsetPx(map, corner, 4, 2)
    map.test.pointerMove(near)

    expect(seen.last?.rawLngLat).toEqual(near)
    // Verbatim, bit for bit: a vertex snap must return the coordinate the store holds,
    // not a projected round-trip of it, or two parcels sharing a corner drift apart.
    expect(seen.last?.lngLat).toEqual(corner)
    await map.destroy()
  })

  it('snaps pointerdown, click and pointerup too — not just pointermove', async () => {
    const map = await snapMap()
    const seen = probe(map)

    const corner = corners(map)[0]!
    const near = offsetPx(map, corner, 3, 0)

    map.test.pointerDown(near)
    map.test.pointerUp(near)
    map.test.click(near)

    // A draw tool commits its vertex on `click`. A snap engine that only ran on
    // `pointermove` would show the indicator on the corner and then place the vertex
    // three pixels away from it, which reads as the software lying.
    expect(seen.all).toHaveLength(3)
    for (const event of seen.all) expect(event.lngLat).toEqual(corner)

    await map.destroy()
  })

  it('holding Alt suppresses snapping for that event, as every CAD package does', async () => {
    const map = await snapMap()
    const seen = probe(map)

    const corner = corners(map)[0]!
    const near = offsetPx(map, corner, 3, 0)

    map.test.pointerMove(near, { alt: true })
    expect(seen.last?.snap).toBeUndefined()
    expect(seen.last?.lngLat).toEqual(near)

    map.test.pointerMove(near)
    expect(seen.last?.lngLat).toEqual(corner)

    await map.destroy()
  })

  it('ignores what is further away than the tolerance, and honours setTolerance', async () => {
    const map = await snapMap({ tolerance: 10 })
    const seen = probe(map)

    const corner = corners(map)[0]!
    // Diagonally *off* the parcel: 15 px west and 15 px south of the south-west corner,
    // so the pointer is 21 px from the corner and 15 px from both edge lines through it.
    // Straight out along an edge would sit *on* that edge, at distance zero — which is a
    // snap, correctly, and would say nothing about the tolerance.
    const far = offsetPx(map, corner, -15, 15)

    map.test.pointerMove(far)
    expect(seen.last?.snap).toBeUndefined()

    map.plugin('snap').setTolerance(30)
    map.test.pointerMove(far)
    expect(seen.last?.snap?.candidate.kind).toBe('vertex')

    expect(() => map.plugin('snap').setTolerance(0)).toThrow(/greater than zero/)
    await map.destroy()
  })

  it('enable/disable is a live switch, and disabling clears the indicator', async () => {
    const map = await snapMap()
    const seen = probe(map)
    const snap = map.plugin('snap')
    const corner = corners(map)[0]!
    const near = offsetPx(map, corner, 3, 0)

    map.test.pointerMove(near)
    expect(map.test.renderer.sources.get(INDICATOR_SOURCE)).toHaveLength(1)

    snap.disable()
    expect(snap.current).toBeUndefined()
    expect(map.test.renderer.sources.get(INDICATOR_SOURCE)).toHaveLength(0)

    map.test.pointerMove(near)
    expect(seen.last?.lngLat).toEqual(near)

    snap.enable()
    map.test.pointerMove(near)
    expect(seen.last?.lngLat).toEqual(corner)

    await map.destroy()
  })

  it('starts disabled when asked to, and stays that way through the enable() the host calls after setup', async () => {
    const map = await snapMap({ enabled: false })
    const seen = probe(map)

    const corner = corners(map)[0]!
    const near = offsetPx(map, corner, 3, 0)
    map.test.pointerMove(near)

    expect(seen.last?.lngLat).toEqual(near)
    await map.destroy()
  })

  it('emits snap:changed on every change and never on a repeat', async () => {
    const map = await snapMap()
    const events: (SnapResult | undefined)[] = []
    map.events.on('snap:changed', (e) => events.push(e.payload.result))

    const corner = corners(map)[0]!
    map.test.pointerMove(offsetPx(map, corner, 3, 0))
    map.test.pointerMove(offsetPx(map, corner, 2, 1)) // same corner: no new event
    map.test.pointerMove(offsetPx(map, corner, 200, 200)) // nothing out here

    expect(events).toHaveLength(2)
    expect(events[0]?.candidate.kind).toBe('vertex')
    expect(events[1]).toBeUndefined()

    await map.destroy()
  })
})

/* ========================================================================= */
/* Providers                                                                 */
/* ========================================================================= */

describe('providers', () => {
  it('a vertex outranks the edge it sits on — the tie that decides everything', async () => {
    const map = await snapMap()
    const seen = probe(map)
    const corner = corners(map)[0]!

    // Straight along the southern edge, so the corner and the perpendicular foot on
    // that edge are at *identical* distance. Priority is the only thing that can
    // break this tie, and if it broke the wrong way no user could ever snap a corner.
    map.test.pointerMove(offsetPx(map, corner, 5, 0))

    const result = seen.last?.snap
    expect(result?.candidate.kind).toBe('vertex')
    expect(result?.alternatives.some((c) => c.kind === 'edge')).toBe(true)
    expect(seen.last?.lngLat).toEqual(corner)

    await map.destroy()
  })

  it('snaps to the midpoint of an edge, over the edge itself', async () => {
    const map = await snapMap()
    const seen = probe(map)

    const [sw, se] = corners(map) as [LngLat, LngLat]
    const middleXY: ProjectedXY = [
      (xy(map, sw)[0] + xy(map, se)[0]) / 2,
      (xy(map, sw)[1] + xy(map, se)[1]) / 2,
    ]
    const middle = map.crs.working.inverse(middleXY)

    map.test.pointerMove(offsetPx(map, middle, 0, 3))

    expect(seen.last?.snap?.candidate.kind).toBe('midpoint')
    expect(pixelsApart(map, seen.last!.lngLat, middle)).toBeLessThan(0.01)

    await map.destroy()
  })

  it('snaps to the perpendicular foot on an edge, computed in the projected plane', async () => {
    const map = await snapMap()
    const seen = probe(map)

    const [sw, se] = corners(map) as [LngLat, LngLat]
    // A quarter of the way along the southern edge: far from both corners and from the
    // midpoint, so `edge` is the only candidate left standing.
    const quarterXY: ProjectedXY = [
      xy(map, sw)[0] + (xy(map, se)[0] - xy(map, sw)[0]) * 0.25,
      xy(map, sw)[1] + (xy(map, se)[1] - xy(map, sw)[1]) * 0.25,
    ]
    const quarter = map.crs.working.inverse(quarterXY)

    map.test.pointerMove(offsetPx(map, quarter, 0, 4))

    const result = seen.last?.snap
    expect(result?.candidate.kind).toBe('edge')
    expect(result?.candidate.edge).toMatchObject({ feature: 'p1', part: 0, ring: 0 })

    // The snapped point is *on* the boundary, to well under a millimetre. Anything
    // else means the foot was computed on lng/lat, where it lands ~30 cm off.
    const snapped = xy(map, seen.last!.lngLat)
    expect(distanceToSegment(snapped, xy(map, sw), xy(map, se))).toBeLessThan(0.001)

    await map.destroy()
  })

  it('snaps to where two edges cross', async () => {
    const map = await createTestMap({
      plugins: [snapPlugin()],
      features: {
        lines: [
          {
            id: 'a',
            geometry: {
              type: 'LineString',
              coordinates: [
                [32.84, 39.93],
                [32.86, 39.93],
              ],
            },
          },
          {
            id: 'b',
            geometry: {
              type: 'LineString',
              coordinates: [
                [32.85, 39.92],
                [32.85, 39.94],
              ],
            },
          },
        ],
      },
    })
    const seen = probe(map)

    const crossing: LngLat = [32.85, 39.93]
    map.test.pointerMove(offsetPx(map, crossing, 3, 2))

    expect(seen.last?.snap?.candidate.kind).toBe('intersection')
    expect(pixelsApart(map, seen.last!.lngLat, crossing)).toBeLessThan(0.01)

    await map.destroy()
  })

  it('snaps to the extension of an edge, beyond its endpoint', async () => {
    const map = await createTestMap({
      plugins: [snapPlugin()],
      features: {
        lines: [
          {
            id: 'a',
            geometry: {
              type: 'LineString',
              coordinates: [
                [32.84, 39.93],
                [32.85, 39.93],
              ],
            },
          },
        ],
      },
    })
    const seen = probe(map)

    const end: LngLat = [32.85, 39.93]
    // 60 px past the end — far outside the tolerance circle of the endpoint and of the
    // segment, so nothing but the *line* can answer.
    const beyond = offsetPx(map, end, 60, 2)
    map.test.pointerMove(beyond)

    const result = seen.last?.snap
    expect(result?.candidate.kind).toBe('extension')
    expect(result?.candidate.edge).toMatchObject({ feature: 'a', index: 0 })
    // It lands *on* the line the edge lies on: the 2 px of perpendicular offset is gone.
    // Asserted in millimetres, not decimal places — a decimal place is not a distance.
    expectWithinMetres(seen.last!.lngLat, [seen.last!.lngLat[0], end[1]], 0.001)

    await map.destroy()
  })

  it('snaps perpendicular from the last in-progress vertex onto a nearby edge', async () => {
    const map = await createTestMap({
      plugins: [snapPlugin({ providers: ['perpendicular'] })],
      features: {
        lines: [
          {
            id: 'a',
            geometry: {
              type: 'LineString',
              coordinates: [
                [32.84, 39.93],
                [32.86, 39.93],
              ],
            },
          },
        ],
      },
    })
    const seen = probe(map)

    const from: LngLat = [32.8503, 39.9345]
    map.plugin('snap').setInProgress([from])

    // The foot is directly "below" `from` on the line — the point that makes the
    // segment from→foot meet the line at 90°.
    const foot: LngLat = [32.8503, 39.93]
    map.test.pointerMove(offsetPx(map, foot, 3, 3))

    expect(seen.last?.snap?.candidate.kind).toBe('perpendicular')

    const a = xy(map, seen.last!.lngLat)
    const p = xy(map, from)
    const edge: ProjectedXY = [
      xy(map, [32.86, 39.93])[0] - xy(map, [32.84, 39.93])[0],
      xy(map, [32.86, 39.93])[1] - xy(map, [32.84, 39.93])[1],
    ]
    const dot = (a[0] - p[0]) * edge[0] + (a[1] - p[1]) * edge[1]
    const scale = Math.hypot(a[0] - p[0], a[1] - p[1]) * Math.hypot(edge[0], edge[1])
    // cos θ ≈ 0: the constructed segment really is perpendicular to the edge.
    expect(Math.abs(dot / scale)).toBeLessThan(1e-6)

    await map.destroy()
  })

  it('snaps to a grid, in metres in the working CRS', async () => {
    const map = await createTestMap({
      plugins: [snapPlugin({ providers: ['grid'], gridSize: 10, tolerance: 40 })],
    })
    const seen = probe(map)

    map.test.pointerMove([32.850123, 39.930456])

    const result = seen.last?.snap
    expect(result?.candidate.kind).toBe('grid')

    const [x, y] = xy(map, seen.last!.lngLat)
    expect(x % 10).toBeCloseTo(0, 6)
    expect(y % 10).toBeCloseTo(0, 6)

    await map.destroy()
  })

  it('snaps to the ring being drawn, so a user can close it on its own first vertex', async () => {
    // No features at all: the only thing on the map is the gesture in progress.
    const map = await createTestMap({ plugins: [snapPlugin()] })
    const seen = probe(map)

    const first: LngLat = [32.85, 39.93]
    map.plugin('snap').setInProgress([first, [32.851, 39.93]])

    map.test.pointerMove(offsetPx(map, first, 4, 1))

    expect(seen.last?.snap?.candidate.kind).toBe('vertex')
    expect(seen.last?.snap?.candidate.feature).toBeUndefined()
    expect(seen.last?.lngLat).toEqual(first)

    await map.destroy()
  })
})

/* ========================================================================= */
/* The extension point                                                       */
/* ========================================================================= */

describe('providers as an extension point', () => {
  it('a third-party provider joins the same auction, and wins on priority', async () => {
    const map = await snapMap()
    const seen = probe(map)
    const snap = map.plugin('snap')

    // Well clear of the parcel: near it, the extensions of its edges are legitimate
    // candidates, and the test would be measuring them rather than the beacon.
    const beacon: LngLat = [32.848, 39.928]
    const handle = snap.addProvider({
      id: 'acme:beacon',
      priority: 200,
      query: (point, tolerancePx, ctx) => {
        const cursor = ctx.project(point)
        const target = ctx.project(beacon)
        const distancePx = Math.hypot(cursor.x - target.x, cursor.y - target.y)
        if (distancePx > tolerancePx) return []
        return [{ kind: 'acme:beacon', point: beacon, distancePx, priority: 200 }]
      },
    })

    map.test.pointerMove(offsetPx(map, beacon, 3, 0))
    expect(seen.last?.snap?.candidate.kind).toBe('acme:beacon')
    expect(seen.last?.lngLat).toEqual(beacon)

    handle.dispose()
    map.test.pointerMove(offsetPx(map, beacon, 3, 0))
    expect(seen.last?.snap).toBeUndefined()

    await map.destroy()
  })

  it('a provider that throws is skipped, not fatal — the cursor must never die', async () => {
    const map = await snapMap()
    const seen = probe(map)

    map.plugin('snap').addProvider({
      id: 'acme:broken',
      query: () => {
        throw new Error('boom')
      },
    })

    const corner = corners(map)[0]!
    map.test.pointerMove(offsetPx(map, corner, 3, 0))

    expect(seen.last?.snap?.candidate.kind).toBe('vertex')
    await map.destroy()
  })

  it('refuses a duplicate provider id, because removeProvider(id) could not tell them apart', async () => {
    const map = await snapMap()
    expect(() => map.plugin('snap').addProvider({ id: 'vertex', query: () => [] })).toThrow(
      /already registered/,
    )
    await map.destroy()
  })

  it('excludes the feature being edited, so it cannot snap to itself', async () => {
    const map = await snapMap()
    const seen = probe(map)
    const corner = corners(map)[0]!

    map.plugin('snap').exclude(['p1'])
    map.test.pointerMove(offsetPx(map, corner, 3, 0))
    expect(seen.last?.snap).toBeUndefined()

    map.plugin('snap').exclude([])
    map.test.pointerMove(offsetPx(map, corner, 3, 0))
    expect(seen.last?.snap?.candidate.kind).toBe('vertex')

    await map.destroy()
  })
})

/* ========================================================================= */
/* The indicator                                                             */
/* ========================================================================= */

describe('the indicator', () => {
  it('draws a themed mark at the snapped point, and takes it away again', async () => {
    const map = await snapMap()
    const corner = corners(map)[0]!

    const layer = map.test.renderer.layers.get(INDICATOR_LAYER)
    expect(layer?.style.circle?.color).toBe(map.theme.token('color').snapIndicator)
    expect(layer?.style.circle?.radius).toBe(map.theme.token('size').snapIndicatorRadius)

    map.test.pointerMove(offsetPx(map, corner, 3, 0))
    const drawn = map.test.renderer.sources.get(INDICATOR_SOURCE)
    expect(drawn).toHaveLength(1)
    expect(drawn?.[0]?.geometry).toEqual({ type: 'Point', coordinates: [corner[0], corner[1]] })
    expect(drawn?.[0]?.properties['kind']).toBe('vertex')

    map.test.pointerMove(offsetPx(map, corner, 300, 300))
    expect(map.test.renderer.sources.get(INDICATOR_SOURCE)).toHaveLength(0)

    await map.destroy()
  })

  it('restyles when the theme changes, rather than baking the colour in at setup', async () => {
    const map = await snapMap()
    map.theme.set({ tokens: { color: { snapIndicator: '#ff00ff' } } })

    expect(map.test.renderer.layers.get(INDICATOR_LAYER)?.style.circle?.color).toBe('#ff00ff')
    await map.destroy()
  })
})
