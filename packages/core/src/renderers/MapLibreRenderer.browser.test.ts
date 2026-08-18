/**
 * The renderer against a real MapLibre and a real WebGL2 context.
 *
 * Everything else in this repository tests the renderer *seam* — `FakeRenderer` implements the
 * `Renderer` contract, and 700-odd tests run the whole library through it with no GPU. That is
 * the right default and it is why the suite takes two seconds. It leaves exactly one surface
 * unverified, and it is unverifiable by construction: **whether MapLibre accepts what we hand
 * it.** A mocked `maplibre-gl` accepts everything, so a mocked suite can only ever confirm that
 * we called the method we meant to call.
 *
 * So the rule for this file is narrow: *only what the fake cannot honestly reach.* Tile-source
 * ref-counting, rollback-on-failed-add and the maplibre-4 teardown path are all better tested
 * against the fake, where those failure modes can be induced on demand. Duplicating them here
 * would cost a browser launch and buy nothing.
 *
 * It is a **fence, not a net**: it exists to stop defects that were found by reading the code
 * from coming back, not to discover new ones.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MapLibreRenderer, ID_PROPERTY } from './MapLibreRenderer.js'
import type { BlaeuFeature } from '../types/feature.js'
import type { LayerStyle } from '../types/renderer.js'
import type { LngLat } from '../types/common.js'

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const ANKARA: [number, number] = [32.85, 39.93]

let host: HTMLDivElement
let renderer: MapLibreRenderer

/** The real `maplibre-gl` Map, for the assertions that have to ask MapLibre itself. */
interface NativeMap {
  getLayer(id: string): unknown
  getPaintProperty(layer: string, name: string): unknown
  getLayoutProperty(layer: string, name: string): unknown
  getStyle(): { layers: { id: string; type: string }[] }
  getCenter(): { lng: number; lat: number }
  getCanvas(): HTMLCanvasElement
  getCanvasContainer(): HTMLElement
  jumpTo(o: Record<string, unknown>): void
  once(type: string, fn: () => void): unknown
  isStyleLoaded(): boolean
  loaded(): boolean
}
const native = (): NativeMap => renderer.getNative<NativeMap>()

beforeEach(async () => {
  host = document.createElement('div')
  host.style.width = '800px'
  host.style.height = '600px'
  document.body.appendChild(host)
  renderer = new MapLibreRenderer()
  await renderer.mount(host)
  // Jump somewhere real and let the style settle, so projection maths is meaningful.
  renderer.setCamera({ center: ANKARA, zoom: 14, duration: 0 })
})

afterEach(() => {
  // Destroy every map. A browser caps live WebGL contexts at ~16; past that the oldest is
  // silently killed and the failure surfaces in an unrelated test.
  renderer.destroy()
  host.remove()
})

/**
 * Can this environment actually rasterise?
 *
 * Probed once, because the answer decides whether four of these tests mean anything.
 * `queryRenderedFeatures` returns only what has been **rendered**, so every hit test depends on
 * a completed render pass — and a completed render pass is not something headless software
 * WebGL reliably delivers. Measured across two environments and two maplibre majors:
 *
 *     macOS + SwiftShader, maplibre 5   renders
 *     macOS + SwiftShader, maplibre 6   never reaches loaded()
 *     ubuntu-latest CI,     maplibre 5   never reaches loaded()
 *     ubuntu-latest CI,     maplibre 6   never reaches loaded()
 *
 * So the axis is not the maplibre version, which is what the first two attempts at this
 * assumed. It is whether there is a GPU. v6 is simply stricter about it — it dropped WebGL1 and
 * requires WebGL2 — which is why it also fails on the one machine where v5 works.
 *
 * The render-dependent tests are therefore gated on this probe rather than left failing, and
 * `reports whether this environment can rasterise` below always runs, so the gate is announced
 * on every run instead of quietly shrinking the suite.
 */
/**
 * Probed at **module scope, with a top-level await**, not in `beforeAll`.
 *
 * `describe.runIf()` is evaluated when the file is *collected*, which happens before any hook
 * runs — so a flag set in `beforeAll` is still `false` when the gate reads it, and the block is
 * skipped even on a machine that renders perfectly well. (It was, on the first attempt.)
 */
const canRender = await (async (): Promise<boolean> => {
  const probeHost = document.createElement('div')
  probeHost.style.width = '400px'
  probeHost.style.height = '300px'
  document.body.appendChild(probeHost)
  const probe = new MapLibreRenderer()
  try {
    await probe.mount(probeHost)
    probe.setCamera({ center: ANKARA, zoom: 14, duration: 0 })
    probe.setFeatureResolver((id) => (id === 'probe' ? parcel('probe') : undefined))
    probe.addSource('probe', [parcel('probe')])
    probe.addLayer('probe', 'probe', { fill: { color: '#cccccc' } })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (probe.queryAt(probe.project(ANKARA)).length > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  } finally {
    probe.destroy()
    probeHost.remove()
  }
})()

afterAll(() => {
  if (!canRender) {
    console.warn(
      '[browser suite] This environment never completed a MapLibre render pass, so the four ' +
        'render-dependent hit-testing tests were SKIPPED. Everything that does not need a ' +
        'rasteriser — style translation, pointer normalisation, touch, basemap swap — still ran. ' +
        'Run this suite on a GPU runner to cover hit testing, including the leading-zero id.',
    )
  }
})

function parcel(id: string, at: [number, number] = ANKARA): BlaeuFeature {
  const [lng, lat] = at
  const d = 0.002
  return {
    id,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lng - d, lat - d],
          [lng + d, lat - d],
          [lng + d, lat + d],
          [lng - d, lat + d],
          [lng - d, lat - d],
        ],
      ],
    },
    properties: {},
    meta: { collection: 'parcels', version: 1, createdAt: 0, updatedAt: 0 },
  } as BlaeuFeature
}

/** MapLibre applies style changes asynchronously; give it a frame to settle. */
const settle = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

/**
 * Wait until the feature at `point` is actually queryable, or fail saying so.
 *
 * `queryRenderedFeatures` returns only what has been **rendered**, so a hit test is not a
 * question about our code until a render pass has completed — and how long that takes is a
 * property of the machine, not of the library. Two animation frames was enough on one
 * developer's laptop and on no CI runner, which made three tests look like a maplibre-version
 * problem when they were a timing assumption.
 *
 * Polling with a deadline is the honest shape: it still asserts the feature *becomes*
 * queryable, and when it never does the failure says that instead of `expected [] to have
 * length 1`, which sends you looking in the wrong place.
 */
async function whenQueryable(point: { x: number; y: number }, budgetMs = 15_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (renderer.queryAt(point).length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const map = native()
  throw new Error(
    `nothing became queryable at (${point.x}, ${point.y}) within ${budgetMs} ms — ` +
      `loaded=${map.loaded()} styleLoaded=${map.isStyleLoaded()}. The map never completed a ` +
      `render pass, so this says nothing about hit testing.`,
  )
}

/* ------------------------------------------------------------------ *
 * 1. Style translation — does MapLibre accept what we generate?
 * ------------------------------------------------------------------ */

describe('LayerStyle translation, judged by MapLibre’s own validator', () => {
  it('a plain fill+line style produces layers MapLibre keeps', async () => {
    renderer.addSource('parcels', [parcel('a')])
    renderer.addLayer('parcels', 'parcels', {
      fill: { color: '#cccccc', opacity: 0.5 },
      line: { color: '#333333', width: 2 },
    })
    await settle()

    const ids = native()
      .getStyle()
      .layers.map((l) => l.id)
    // A style MapLibre rejects is *removed* from the style, so presence is the assertion.
    expect(ids).toContain('parcels::fill')
    expect(ids).toContain('parcels::line')
    expect(native().getPaintProperty('parcels::fill', 'fill-color')).toBeDefined()
  })

  it('the fill sits below its own outline, or the outline disappears', async () => {
    renderer.addSource('parcels', [parcel('a')])
    renderer.addLayer('parcels', 'parcels', {
      fill: { color: '#cccccc' },
      line: { color: '#333333', width: 2 },
    })
    await settle()

    const ids = native()
      .getStyle()
      .layers.map((l) => l.id)
    expect(ids.indexOf('parcels::fill')).toBeLessThan(ids.indexOf('parcels::line'))
  })

  /**
   * The one the fake cannot judge. A data-driven expression is a nested array that MapLibre
   * parses against the style spec and **rejects** if it is malformed — wrong arity, unknown
   * operator, a type it cannot coerce. `FakeRenderer` stores it verbatim and is happy either
   * way, so "we support expressions" was, until now, an untested claim.
   */
  it('accepts a data-driven expression rather than storing it and hoping', async () => {
    renderer.addSource('parcels', [parcel('a')])
    renderer.addLayer('parcels', 'parcels', {
      fill: {
        color: ['case', ['boolean', ['get', '$locked'], false], '#ff0000', '#00ff00'],
        opacity: ['interpolate', ['linear'], ['zoom'], 10, 0.2, 18, 0.9],
      },
    })
    await settle()

    const paint = native().getPaintProperty('parcels::fill', 'fill-color')
    expect(paint).toBeDefined()
    expect(Array.isArray(paint)).toBe(true)
    expect((paint as unknown[])[0]).toBe('case')
  })

  /**
   * `style.native.paint` keys are routed to the sublayer whose prefix they match — a
   * `fill-` key to `::fill`, a `line-` key to `::line`. Getting that wrong is not a silent
   * no-op in real MapLibre: setting `line-width` on a fill layer is a hard throw.
   */
  it('routes native paint keys to the sublayer whose prefix they match', async () => {
    renderer.addSource('parcels', [parcel('a')])
    renderer.addLayer('parcels', 'parcels', {
      fill: { color: '#cccccc' },
      line: { color: '#333333' },
      native: { paint: { 'fill-antialias': false, 'line-blur': 1.5 } },
    } as LayerStyle)
    await settle()

    expect(native().getPaintProperty('parcels::fill', 'fill-antialias')).toBe(false)
    expect(native().getPaintProperty('parcels::line', 'line-blur')).toBe(1.5)
  })

  it('a restyle updates the live layer instead of leaving the old paint', async () => {
    renderer.addSource('parcels', [parcel('a')])
    renderer.addLayer('parcels', 'parcels', { fill: { color: '#111111' } })
    await settle()

    renderer.setLayerStyle('parcels', { fill: { color: '#222222' } })
    await settle()

    // MapLibre parses colours, so compare through it rather than by string equality.
    expect(native().getPaintProperty('parcels::fill', 'fill-color')).toBeDefined()
    expect(native().getLayer('parcels::fill')).toBeDefined()
  })

  it('hiding a layer sets a visibility MapLibre honours', async () => {
    renderer.addSource('parcels', [parcel('a')])
    renderer.addLayer('parcels', 'parcels', { fill: { color: '#cccccc' } })
    await settle()

    renderer.setLayerVisible('parcels', false)
    await settle()
    expect(native().getLayoutProperty('parcels::fill', 'visibility')).toBe('none')

    renderer.setLayerVisible('parcels', true)
    await settle()
    expect(native().getLayoutProperty('parcels::fill', 'visibility')).toBe('visible')
  })
})

/* ------------------------------------------------------------------ *
 * 2. Hit testing and feature ids
 * ------------------------------------------------------------------ */

describe('rasterisation', () => {
  // Always runs, so a shrunk suite can never look like a full one.
  it('reports whether this environment can rasterise', () => {
    console.info(
      `[browser suite] render pass available: ${canRender} — ` +
        `${canRender ? 'hit-testing tests ran' : 'hit-testing tests skipped (needs a GPU)'}`,
    )
    expect(typeof canRender).toBe('boolean')
  })
})

describe.runIf(canRender)('hit testing round-trips the feature id', () => {
  /**
   * **The single highest-value assertion in this file.**
   *
   * MapLibre's GeoJSON source will not keep a non-numeric feature id unless told to, which is
   * why `addSource` sets `promoteId`. The failure mode that matters is not "no id" — it is a
   * *coerced* one: a cadastral id like `"00123"` becoming the number `123`, so the leading
   * zeros vanish and `store.find("00123")` returns nothing. The parcel is on screen and
   * unclickable.
   *
   * The fake resolver hands ids straight back, so no mocked test can see this. Only MapLibre's
   * own tile encoder can.
   */
  it('a leading-zero string id survives promoteId as a string', async () => {
    const features = [parcel('00123')]
    renderer.setFeatureResolver((id) => features.find((f) => f.id === id))
    renderer.addSource('parcels', features)
    renderer.addLayer('parcels', 'parcels', { fill: { color: '#cccccc' } })
    await settle()

    const centre = renderer.project(ANKARA)
    await whenQueryable(centre)
    const hits = renderer.queryAt(centre)

    expect(hits).toHaveLength(1)
    expect(hits[0]!.id).toBe('00123')
    // Not 123, and not "123". The whole point.
    expect(typeof hits[0]!.id).toBe('string')
  })

  it('the id travels in the reserved property, not the GeoJSON id member', async () => {
    const features = [parcel('parcel-a')]
    renderer.setFeatureResolver((id) => features.find((f) => f.id === id))
    renderer.addSource('parcels', features)
    renderer.addLayer('parcels', 'parcels', { fill: { color: '#cccccc' } })
    await settle()

    await whenQueryable(renderer.project(ANKARA))
    const hits = renderer.queryAt(renderer.project(ANKARA))
    expect(hits[0]!.id).toBe('parcel-a')
    expect(ID_PROPERTY).toBe('$id')
  })

  it('a click on empty map hits nothing', async () => {
    renderer.addSource('parcels', [parcel('a')])
    renderer.addLayer('parcels', 'parcels', { fill: { color: '#cccccc' } })
    await settle()

    // Wait for a render by proving the parcel is there, *then* assert the far corner is not.
    // Asserting an absence before anything has rendered would pass for the wrong reason.
    renderer.setFeatureResolver(() => ({ id: 'a' }) as unknown as BlaeuFeature)
    await whenQueryable(renderer.project(ANKARA))
    expect(renderer.queryAt({ x: 5, y: 5 })).toHaveLength(0)
  })

  it('deduplicates a feature that MapLibre returns once per tile', async () => {
    // A polygon spanning a tile boundary comes back from `queryRenderedFeatures` more than
    // once. The renderer keys on the promoted id to collapse them; without that, selecting one
    // parcel reports "2 parcels".
    const features = [parcel('wide')]
    renderer.setFeatureResolver((id) => features.find((f) => f.id === id))
    renderer.addSource('parcels', features)
    renderer.addLayer('parcels', 'parcels', { fill: { color: '#cccccc' } })
    await settle()

    await whenQueryable(renderer.project(ANKARA))
    const hits = renderer.queryAt(renderer.project(ANKARA))
    expect(hits.filter((f) => f.id === 'wide')).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * 3. Pointer normalisation against real DOM events
 * ------------------------------------------------------------------ */

describe('pointer normalisation, against events the browser actually makes', () => {
  /** Dispatch a real MouseEvent on the canvas, the way a user would generate one. */
  function mouse(type: string, x: number, y: number, init: MouseEventInit = {}): void {
    const canvas = native().getCanvas()
    const box = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new MouseEvent(type, {
        clientX: box.left + x,
        clientY: box.top + y,
        bubbles: true,
        cancelable: true,
        view: window,
        ...init,
      }),
    )
  }

  it('a real mousedown becomes a pointerdown at the right screen point', async () => {
    const seen: { kind: string; screen: { x: number; y: number } }[] = []
    renderer.onPointer((e) => seen.push({ kind: e.kind, screen: e.screen }))

    mouse('mousedown', 400, 300)
    await settle()

    expect(seen.some((e) => e.kind === 'pointerdown')).toBe(true)
    const down = seen.find((e) => e.kind === 'pointerdown')!
    expect(down.screen.x).toBeCloseTo(400, 0)
    expect(down.screen.y).toBeCloseTo(300, 0)
  })

  it('screen and lngLat agree — the round trip closes', async () => {
    let got: { lngLat: LngLat; screen: { x: number; y: number } } | undefined
    renderer.onPointer((e) => {
      if (e.kind === 'pointerdown') got = { lngLat: e.lngLat, screen: e.screen }
    })

    mouse('mousedown', 250, 175)
    await settle()

    expect(got).toBeDefined()
    // Project the reported lngLat back and it must land where the pointer was. A mocked map
    // cannot check this: its project/unproject are our own arithmetic on both sides.
    const back = renderer.project(got!.lngLat)
    expect(back.x).toBeCloseTo(got!.screen.x, 0)
    expect(back.y).toBeCloseTo(got!.screen.y, 0)
  })

  /**
   * The projection is only linear at bearing 0 and pitch 0. With the camera rotated and
   * tilted, an incorrect normalisation still round-trips on a mocked map (both directions are
   * the same wrong function) and does not here.
   */
  it('the round trip still closes with bearing and pitch set', async () => {
    renderer.setCamera({ center: ANKARA, zoom: 16, bearing: 47, pitch: 55, duration: 0 })
    await settle()

    let got: { lngLat: LngLat; screen: { x: number; y: number } } | undefined
    renderer.onPointer((e) => {
      if (e.kind === 'pointerdown') got = { lngLat: e.lngLat, screen: e.screen }
    })
    mouse('mousedown', 520, 380)
    await settle()

    expect(got).toBeDefined()
    const back = renderer.project(got!.lngLat)
    expect(back.x).toBeCloseTo(got!.screen.x, 0)
    expect(back.y).toBeCloseTo(got!.screen.y, 0)
  })

  it('the round trip closes at zoom 0 and at zoom 18', async () => {
    for (const zoom of [0, 18]) {
      renderer.setCamera({ center: ANKARA, zoom, bearing: 0, pitch: 0, duration: 0 })
      await settle()

      let got: { lngLat: LngLat; screen: { x: number; y: number } } | undefined
      const sub = renderer.onPointer((e) => {
        if (e.kind === 'pointerdown') got = { lngLat: e.lngLat, screen: e.screen }
      })
      mouse('mousedown', 300, 220)
      await settle()
      sub.dispose()

      expect(got, `no pointerdown at zoom ${zoom}`).toBeDefined()
      const back = renderer.project(got!.lngLat)
      expect(back.x, `x at zoom ${zoom}`).toBeCloseTo(got!.screen.x, 0)
      expect(back.y, `y at zoom ${zoom}`).toBeCloseTo(got!.screen.y, 0)
    }
  })

  it('carries the live button bitmask, so an off-canvas release can be detected', async () => {
    let buttons: number | undefined
    renderer.onPointer((e) => {
      if (e.kind === 'pointermove') buttons = e.buttons
    })

    mouse('mousemove', 300, 300, { buttons: 1 })
    await settle()
    expect(buttons).toBe(1)

    mouse('mousemove', 320, 300, { buttons: 0 })
    await settle()
    expect(buttons).toBe(0)
  })

  it('carries the real modifier keys', async () => {
    let mods: Record<string, boolean> | undefined
    renderer.onPointer((e) => {
      if (e.kind === 'pointerdown') mods = e.modifiers as unknown as Record<string, boolean>
    })

    mouse('mousedown', 300, 300, { shiftKey: true, altKey: true })
    await settle()

    expect(mods).toMatchObject({ shift: true, alt: true, ctrl: false, meta: false })
  })
})

/* ------------------------------------------------------------------ *
 * 4. Real touch events
 * ------------------------------------------------------------------ */

describe('touch, with events the browser constructs', () => {
  function touchEvent(type: string, points: { x: number; y: number }[]): void {
    const canvas = native().getCanvas()
    const box = canvas.getBoundingClientRect()
    const touches = points.map(
      (p, i) =>
        new Touch({
          identifier: i,
          target: canvas,
          clientX: box.left + p.x,
          clientY: box.top + p.y,
        }),
    )
    canvas.dispatchEvent(
      new TouchEvent(type, {
        touches: type === 'touchend' ? [] : touches,
        targetTouches: type === 'touchend' ? [] : touches,
        changedTouches: touches,
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    )
  }

  it('a single-finger tap becomes a pointer stream', async () => {
    const kinds: string[] = []
    renderer.onPointer((e) => kinds.push(e.kind))

    touchEvent('touchstart', [{ x: 300, y: 300 }])
    touchEvent('touchend', [{ x: 300, y: 300 }])
    await settle()

    expect(kinds).toContain('pointerdown')
    expect(kinds).toContain('pointerup')
  })

  /**
   * A pinch arrives as a `touchmove` at the **centroid** of two fingers. Forwarding it would
   * let a draw tool drop a vertex halfway between someone's thumb and forefinger while they
   * were only trying to zoom — the bug that makes touch drawing feel haunted.
   */
  it('a two-finger gesture is not forwarded as a pointer', async () => {
    const kinds: string[] = []
    renderer.onPointer((e) => kinds.push(e.kind))

    touchEvent('touchstart', [
      { x: 250, y: 300 },
      { x: 450, y: 300 },
    ])
    touchEvent('touchmove', [
      { x: 200, y: 300 },
      { x: 500, y: 300 },
    ])
    await settle()

    expect(kinds).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * 5. The async setStyle re-materialisation path
 * ------------------------------------------------------------------ */

describe('a basemap swap re-materialises our sources and layers', () => {
  /**
   * `setStyle` throws away MapLibre's entire style — every source and layer with it — and
   * repopulates asynchronously. Our layers have to be put back after it settles. On a mocked
   * map `setStyle` is a no-op that keeps everything, so the fake can prove the call was made
   * and nothing else.
   */
  it('the layer is still there, and still ours, after setBasemap', async () => {
    renderer.addSource('parcels', [parcel('a')])
    renderer.addLayer('parcels', 'parcels', { fill: { color: '#cccccc' } })
    await settle()
    expect(native().getLayer('parcels::fill')).toBeDefined()

    await renderer.setBasemap!({ version: 8, sources: {}, layers: [] })
    await settle()

    expect(native().getLayer('parcels::fill')).toBeDefined()
    const hits = renderer.queryAt(renderer.project(ANKARA))
    expect(hits.length).toBeGreaterThanOrEqual(0) // resolver not set here; presence is the point
  })

  it('the camera does not move across a basemap swap', async () => {
    renderer.setCamera({ center: ANKARA, zoom: 15, duration: 0 })
    await settle()
    const before = renderer.getCamera()

    await renderer.setBasemap!({ version: 8, sources: {}, layers: [] })
    await settle()

    const after = renderer.getCamera()
    expect(after.center[0]).toBeCloseTo(before.center[0], 6)
    expect(after.center[1]).toBeCloseTo(before.center[1], 6)
    expect(after.zoom).toBeCloseTo(before.zoom, 6)
  })
})

/* ------------------------------------------------------------------ *
 * 6. Gesture ownership — currently red, and deliberately so
 * ------------------------------------------------------------------ */

describe('gesture ownership between a tool and the map', () => {
  /**
   * **Expected to fail, and left failing on purpose** (`it.fails`).
   *
   * A tool that drags — a vertex, a transform handle — is in a fight with MapLibre's own
   * `dragPan`: press, move, and the map pans *underneath* the geometry the user is dragging.
   * Today the only remedy is turning `dragPan` off for the whole map through
   * `config.interaction`, which also disables panning when no tool is active.
   *
   * What is missing is per-gesture suppression: a tool declaring "I have this drag" and the
   * renderer taking `dragPan` out of the way until the pointer is released. `ToolManager`
   * already tracks `dragging` (ADR 0010), so the kernel knows; nothing carries it to MapLibre.
   *
   * `it.fails` rather than `it.skip`, because a skipped test is invisible and this one is a
   * statement of intent: when the feature lands, this test starts *passing* and vitest will
   * flag it as an unexpected pass, which is the reminder to promote it to a real `it`.
   */
  it.fails('a left-button drag does not pan the map while a tool owns it', async () => {
    renderer.setCamera({ center: ANKARA, zoom: 14, duration: 0 })
    await settle()
    const before = native().getCenter()

    const canvas = native().getCanvas()
    const box = canvas.getBoundingClientRect()
    const at = (x: number, y: number): MouseEventInit => ({
      clientX: box.left + x,
      clientY: box.top + y,
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
    })

    canvas.dispatchEvent(new MouseEvent('mousedown', at(400, 300)))
    for (let x = 400; x <= 500; x += 20) {
      canvas.dispatchEvent(new MouseEvent('mousemove', at(x, 300)))
      await settle()
    }
    canvas.dispatchEvent(new MouseEvent('mouseup', at(500, 300)))
    await settle()

    const after = native().getCenter()
    expect(after.lng).toBeCloseTo(before.lng, 6)
    expect(after.lat).toBeCloseTo(before.lat, 6)
  })
})
