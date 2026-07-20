import { describe, expect, it } from 'vitest'
import type { Command, CommandContext, LngLat } from '@blaeu/core'
import { createTestMap, ANKARA, offsetMetres, parcelFixture } from '@blaeu/core/testing'
import type { TestMap } from '@blaeu/core/testing'

import { measurePlugin } from './plugin.js'
import { toDms } from './format.js'
import type { Measurement } from './types.js'
import {
  LABEL_COLLECTION,
  MEASURE_COLLECTION,
  DRAFT_COLLECTION,
  DRAFT_LABEL_COLLECTION,
} from './types.js'

/**
 * TUREF / TM30 — the plane a Turkish cadastre actually works on, and the one the
 * fixtures at 39.93°N fall inside. The kernel's default working CRS is EPSG:3857,
 * whose area at this latitude is inflated by 1/cos²φ ≈ 1.7 — fine for tiles, useless
 * for a parcel. Every test here sets the working CRS on purpose, because "which
 * plane?" is the question this plugin exists to answer.
 */
const TM30 = 'EPSG:5254'

/** A 50 m × 40 m parcel = 2 000 m² **on the ground**, at Ankara. */
const SW = ANKARA
const SE = offsetMetres(ANKARA, 50, 0)
const NE = offsetMetres(ANKARA, 50, 40)
const NW = offsetMetres(ANKARA, 0, 40)

/**
 * The same parcel's area **on the TM30 grid**: 2 002.93 m².
 *
 * The 3 m² is not an error and not a rounding artefact — it is the transverse-Mercator
 * scale factor. Ankara sits 2.85° east of the belt's 30°E central meridian, where
 * k ≈ 1.00073, so a grid length is 1.00073 × its ground length and a grid *area* is
 * k² ≈ 1.00146 × its ground area. This is the number a Turkish land registry's own
 * coordinates give, because the registry's coordinates are grid coordinates. A
 * measurement tool that "corrected" it to 2 000 would disagree with the deed.
 *
 * The tests below assert the grid number, deliberately. If a future change makes them
 * report 2 000.00, something has stopped going through the working CRS.
 */
const GRID_AREA_M2 = 2002.93
/** k at Ankara in the 30°E belt: a 50 m ground edge is 50.037 m on the grid. */
const GRID_SCALE = 1.000732

async function measureMap(options: Parameters<typeof measurePlugin>[0] = {}): Promise<TestMap> {
  return createTestMap({
    plugins: [measurePlugin(options)],
    config: { crs: { working: TM30 } },
    camera: { center: ANKARA, zoom: 17 },
  })
}

/** Clicks each corner and finishes with a double-click on the last one, as a user does. */
async function drawArea(map: TestMap, corners: readonly LngLat[]): Promise<void> {
  map.tools.activate('measure:area')
  for (const corner of corners) {
    map.test.pointerMove(corner)
    map.test.click(corner)
  }
  // The browser fires `click` before `dblclick`; the harness does not, so we emit the
  // pair the way the DOM would — which is exactly the sequence the vertex-dedupe in
  // `addVertex` has to survive.
  const last = corners.at(-1)!
  map.test.click(last)
  map.test.dblClick(last)
  // The tool fires the completion off with `void session.complete()`, so the store write
  // lands on a later macrotask. Let the commit pipeline settle before anyone reads it.
  await map.test.flush()
}

describe('planar vs spherical — the whole reason this plugin uses ctx.crs', () => {
  /**
   * If this test ever starts failing, somebody has replaced `ctx.crs.area()` with
   * `@turf/area`, the two numbers have collapsed into one, and every area BlaeuMap
   * reports is now a spherical approximation. That is the bug this plugin was written
   * to prevent, so the test is named after it rather than after what it asserts.
   */
  it('the planar (EPSG:5254) area and the spherical area of a 2 000 m2 parcel at 39N DIFFER', async () => {
    const map = await measureMap()
    map.test.seed('parcels', [parcelFixture('p')])

    const planar = map.plugin('measure').measureFeature('p').areaMetres2
    const spherical = sphericalArea([SW, SE, NE, NW])

    // Both round to "2 000 m²" in a headline. To a land registry they are different
    // parcels: they disagree by about 5 m², and boundary disputes are decided by less.
    expect(spherical).toBeGreaterThan(1990)
    expect(spherical).toBeLessThan(2010)
    expect(planar).toBeCloseTo(GRID_AREA_M2, 0)
    expect(Math.abs(planar - spherical)).toBeGreaterThan(1)
    expect(planar).not.toBe(spherical)

    await map.destroy()
  })

  it('the working CRS is what decides the number — EPSG:3857 is wrong here by 70%', async () => {
    const map = await createTestMap({ plugins: [measurePlugin()], camera: { center: ANKARA } })
    map.test.seed('parcels', [parcelFixture('p')])

    // Web Mercator, the kernel's default, inflates area by 1/cos²(39.93°) ≈ 1.70. This
    // is not a bug in the plugin — it is the reason a cadastre preset sets a working
    // CRS, and the reason `measureFeature` goes through `ctx.crs` rather than
    // computing anything itself.
    const mercator = map.plugin('measure').measureFeature('p').areaMetres2
    expect(mercator / 2000).toBeCloseTo(1 / Math.cos((39.93 * Math.PI) / 180) ** 2, 1)

    map.crs.setWorking(TM30)
    expect(map.plugin('measure').measureFeature('p').areaMetres2).toBeCloseTo(GRID_AREA_M2, 0)

    await map.destroy()
  })
})

describe('measuring', () => {
  it('measures a distance planar, in metres, along the segments the user clicked', async () => {
    const map = await measureMap()

    map.tools.activate('measure:distance')
    map.test.pointerMove(SW)
    map.test.click(SW)
    map.test.pointerMove(SE)
    map.test.click(SE)
    map.test.click(NE)
    map.test.dblClick(NE)
    await map.test.flush()

    const [measurement] = map.plugin('measure').measurements
    expect(measurement).toBeDefined()
    expect(measurement!.mode).toBe('distance')
    // 50 m along the south edge, then 40 m up the east edge — on the ground. On the
    // grid, both are longer by the scale factor, and the tool reports the grid length
    // because that is what the working CRS says.
    expect(measurement!.lengthMetres).toBeCloseTo(90 * GRID_SCALE, 1)
    expect(measurement!.lengthMetres).toBeGreaterThan(90)
    expect(measurement!.segments.map((s) => Math.round(s.lengthMetres))).toEqual([50, 40])
    expect(measurement!.geometry.type).toBe('LineString')

    await map.destroy()
  })

  it('measures an area and reports its perimeter', async () => {
    const map = await measureMap()
    await drawArea(map, [SW, SE, NE, NW])

    const [measurement] = map.plugin('measure').measurements
    expect(measurement!.mode).toBe('area')
    expect(measurement!.geometry.type).toBe('Polygon')
    expect(measurement!.areaMetres2).toBeCloseTo(GRID_AREA_M2, 0)
    // Perimeter, holes included — 2 × (50 + 40), on the grid.
    expect(measurement!.lengthMetres).toBeCloseTo(180 * GRID_SCALE, 1)
    expect(measurement!.value).toBe(measurement!.areaMetres2)

    await map.destroy()
  })

  it('reports a GRID bearing, clockwise from grid north, in DMS and decimal degrees', async () => {
    const map = await measureMap()

    map.tools.activate('measure:bearing')
    map.test.pointerMove(SW)
    map.test.click(SW)
    map.test.click(SE) // due east on the ground
    // Two clicks complete a bearing, via `void session.complete()` — a later macrotask.
    await map.test.flush()

    const [measurement] = map.plugin('measure').measurements
    expect(measurement!.mode).toBe('bearing')
    // Two clicks complete a bearing — no double-click needed.
    expect(map.plugin('measure').measurements).toHaveLength(1)

    const bearing = measurement!.bearing
    expect(bearing).toBeDefined()
    // Grid east, not true east: the two differ by the convergence of meridians, which
    // at 32.85°E in a belt centred on 30°E is a couple of degrees — visible here, and
    // exactly the correction a surveyor wants applied.
    expect(bearing!.degrees).toBeGreaterThan(88)
    expect(bearing!.degrees).toBeLessThan(93)
    expect(bearing!.dms).toMatch(/^\d+° \d{2}' \d{2}"$/)
    expect(measurement!.label).toContain(bearing!.dms)
    expect(measurement!.label).toContain(bearing!.decimal)

    await map.destroy()
  })

  it('converts seconds that round to 60 rather than printing 59\' 60"', () => {
    expect(toDms(12.999999)).toBe('13° 00\' 00"')
    expect(toDms(0)).toBe('0° 00\' 00"')
    expect(toDms(-90)).toBe('270° 00\' 00"') // a bearing wraps; it does not go negative
    expect(toDms(123.7533)).toBe('123° 45\' 12"')
  })
})

describe('units and locale', () => {
  it('formats area in donum (1 000 m2) with Turkish separators', async () => {
    const map = await createTestMap({
      plugins: [measurePlugin({ areaUnit: 'donum' })],
      config: { crs: { working: TM30 }, locale: 'tr' },
      camera: { center: ANKARA, zoom: 17 },
    })
    map.test.seed('parcels', [parcelFixture('p')])

    const measurement = map.plugin('measure').measureFeature('p')
    // 2 000 m² = 2 dönüm. The unit a Turkish surveyor actually reads a parcel in.
    expect(measurement.areaMetres2 / 1000).toBeCloseTo(2, 1)
    expect(measurement.label).toMatch(/^2,\d{3} dönüm$/)

    await map.destroy()
  })

  it('formats m2 through i18n.area(), so Turkish gets a comma decimal separator', async () => {
    const map = await createTestMap({
      plugins: [measurePlugin()],
      config: { crs: { working: TM30 }, locale: 'tr' },
      camera: { center: ANKARA, zoom: 17 },
    })
    map.test.seed('parcels', [parcelFixture('p')])

    const label = map.plugin('measure').measureFeature('p').label
    expect(label).toMatch(/m²$/)
    // `1.999,97 m²` — dot for thousands, comma for decimals. An English-formatted
    // `1,999.97` in a Turkish UI is not merely foreign, it is ambiguous.
    expect(label).toMatch(/^\d\.\d{3},\d{2} m²$/)

    await map.destroy()
  })

  it('re-derives the labels when the locale changes', async () => {
    const map = await measureMap()
    await drawArea(map, [SW, SE, NE, NW])

    const before = map.store.collection(LABEL_COLLECTION).all().at(-1)?.properties['label']
    expect(String(before)).toMatch(/^\d,\d{3}\.\d{2} m²$/) // en: 1,999.97 m²

    map.i18n.setLocale('tr')

    const after = map.store.collection(LABEL_COLLECTION).all().at(-1)?.properties['label']
    expect(String(after)).toMatch(/^\d\.\d{3},\d{2} m²$/) // tr: 1.999,97 m²

    await map.destroy()
  })
})

describe('labels and the live rubber band', () => {
  it('labels every segment at its midpoint and the total at the polygon centroid', async () => {
    const map = await measureMap()
    await drawArea(map, [SW, SE, NE, NW])

    const labels = map.store.collection(LABEL_COLLECTION).all()
    // Four segments (the ring closes) plus one total.
    expect(labels).toHaveLength(5)
    expect(labels.filter((f) => f.properties['kind'] === 'segment')).toHaveLength(4)

    const total = labels.find((f) => f.properties['kind'] === 'total')!
    expect(String(total.properties['label'])).toContain('m²')

    // The area label sits at the ring's area-weighted centroid, computed **on the
    // plane**. Compare it against the midpoint of the parcel's diagonal, also on the
    // plane: the two agree to a few centimetres and not exactly, because converging
    // meridians project the ground rectangle into a slight trapezoid — whose centroid
    // is genuinely not its diagonal midpoint. That residual is the projection being
    // honest, and it is why the centroid is computed rather than assumed.
    const plane = map.crs.working
    const [ax, ay] = plane.forward(SW)
    const [bx, by] = plane.forward(NE)
    const diagonalMidpoint = plane.inverse([(ax + bx) / 2, (ay + by) / 2])

    const at = (total.geometry as { coordinates: number[] }).coordinates
    expect(map.crs.distance([at[0]!, at[1]!], diagonalMidpoint)).toBeLessThan(0.2)

    await map.destroy()
  })

  it('marks the rubber band and its labels non-snappable, so the pointer cannot pin to them', async () => {
    // The classic bug: the draft band is written to the store as an ordinary feature, so the
    // snap engine offers it as a candidate and the pointer snaps to the previous frame's band —
    // pinning the measurement to itself. The snap engine skips `meta.snappable === false`, so
    // every draft feature the tool paints mid-gesture must carry it. (Committed measurements
    // stay snappable — those a surveyor may legitimately want to snap to.)
    const map = await measureMap()
    map.tools.activate('measure:distance')
    map.test.click(SW)
    map.test.pointerMove(SE) // the rubber band is now painted

    const band = map.store.collection(DRAFT_COLLECTION).all()
    const labels = map.store.collection(DRAFT_LABEL_COLLECTION).all()
    expect(band.length).toBeGreaterThan(0)
    expect(labels.length).toBeGreaterThan(0)
    for (const feature of [...band, ...labels]) {
      expect(feature.meta.snappable).toBe(false)
    }

    await map.destroy()
  })

  it('leaves the committed measurement snappable but its label anchors non-snappable', async () => {
    // The measurement line/ring is a legitimate snap target — a surveyor may want to snap a
    // later parcel corner to it. Its labels are not: each is a Point at a segment midpoint or,
    // for an area, at the ring centroid, which lies on no boundary. Left snappable, that centroid
    // becomes a top-priority snap target on empty space. So: geometry snappable, labels not.
    const map = await measureMap()
    await drawArea(map, [SW, SE, NE, NW])

    const geometry = map.store.collection(MEASURE_COLLECTION).all()
    const labels = map.store.collection(LABEL_COLLECTION).all()
    expect(geometry).toHaveLength(1)
    expect(labels.length).toBeGreaterThan(0)
    expect(geometry[0]?.meta.snappable).not.toBe(false)
    for (const label of labels) {
      expect(label.meta.snappable).toBe(false)
    }

    await map.destroy()
  })

  it('shows the rubber-band segment length before the vertex is committed, and clears it after', async () => {
    const map = await measureMap()
    const seen: Measurement[] = []
    map.events.on('measure:update', (e) => seen.push(e.payload.measurement))

    map.tools.activate('measure:distance')
    map.test.click(SW)
    map.test.pointerMove(SE) // not clicked yet — this is the rubber band

    const draft = seen.at(-1)!
    expect(draft.draft).toBe(true)
    expect(draft.lengthMetres).toBeCloseTo(50, 1)
    // And it is on the map, with its length already on it.
    expect(map.store.collection(DRAFT_COLLECTION).size).toBe(1)

    map.test.click(SE)
    map.test.dblClick(SE)
    await map.test.flush()

    // Committing hands the geometry over to the measure collection and takes the
    // rubber band down. A draft left on screen after a commit is the classic
    // "why is there a ghost line" bug.
    expect(map.store.collection(DRAFT_COLLECTION).size).toBe(0)
    expect(map.store.collection(MEASURE_COLLECTION).size).toBe(1)

    await map.destroy()
  })

  it('emits start, update, complete and clear', async () => {
    const map = await measureMap()
    const events: string[] = []
    for (const name of [
      'measure:start',
      'measure:update',
      'measure:complete',
      'measure:clear',
    ] as const) {
      map.events.on(name, () => events.push(name))
    }

    await drawArea(map, [SW, SE, NE, NW])
    await map.plugin('measure').clear()

    expect(events[0]).toBe('measure:start')
    expect(events).toContain('measure:update')
    expect(events.at(-2)).toBe('measure:complete')
    expect(events.at(-1)).toBe('measure:clear')

    await map.destroy()
  })
})

describe('persist', () => {
  it('accumulates measurements by default', async () => {
    const map = await measureMap()
    await drawArea(map, [SW, SE, NE, NW])
    await drawArea(map, [SW, SE, NE, NW])

    expect(map.plugin('measure').measurements).toHaveLength(2)
    await map.destroy()
  })

  it('keeps only the newest when persist is false', async () => {
    const map = await measureMap({ persist: false })
    await drawArea(map, [SW, SE, NE, NW])
    // Re-activating the *same* tool is a no-op in the ToolManager, so start() again the
    // way a toolbar would: switch away, then back.
    map.tools.deactivate()
    await drawArea(map, [SW, SE, NE, NW])

    expect(map.plugin('measure').measurements).toHaveLength(1)
    await map.destroy()
  })

  it('clear() removes every measurement and its labels', async () => {
    const map = await measureMap()
    await drawArea(map, [SW, SE, NE, NW])
    await map.plugin('measure').clear()

    expect(map.plugin('measure').measurements).toEqual([])
    expect(map.store.collection(LABEL_COLLECTION).size).toBe(0)
    await map.destroy()
  })
})

describe('measureFeature', () => {
  it('measures a parcel already in the store without adding anything to it', async () => {
    const map = await measureMap()
    map.test.seed('parcels', [parcelFixture('p')])
    const before = map.store.snapshot()

    const measurement = map.plugin('measure').measureFeature('p')

    expect(measurement.mode).toBe('area')
    expect(measurement.areaMetres2).toBeCloseTo(GRID_AREA_M2, 0)
    expect(measurement.segments).toHaveLength(4)
    // Reading is not writing.
    expect(map.store.snapshot()).toEqual(before)
    expect(map.plugin('measure').measurements).toEqual([])

    await map.destroy()
  })

  it('says what to do when the geometry cannot be measured', async () => {
    const map = await measureMap()
    map.test.seed('points', [{ id: 'pt', geometry: { type: 'Point', coordinates: [...SW] } }])

    expect(() => map.plugin('measure').measureFeature('pt')).toThrow(/LineString \(distance\)/)
    expect(() => map.plugin('measure').measureFeature('nope')).toThrow(/no such feature/)

    await map.destroy()
  })
})

describe('options', () => {
  it('refuses planar: false loudly, and says what to do instead', () => {
    // Not a silent downgrade to sphere maths. The whole plugin is planar; an option
    // that quietly turned that off would be a trapdoor under every number it reports.
    expect(() => measurePlugin({ planar: false })).toThrow(/working CRS/)
  })
})

/* ========================================================================= */
/* The three tests every plugin owes                                         */
/* ========================================================================= */

describe('the three tests every plugin owes', () => {
  it('1. degrades: measures without the snap plugin installed', async () => {
    // No snap plugin. The tools read `ctx.lngLat`, which is then simply the raw pointer
    // — un-snapped measuring is exactly what an un-snapped map should do. (With snap
    // installed, the same code measures corner-to-corner, because the middleware
    // rewrote `ctx.lngLat` before any tool saw it. This plugin never learns which.)
    const map = await measureMap()
    expect(map.plugins.has('snap')).toBe(false)

    await drawArea(map, [SW, SE, NE, NW])

    expect(map.plugin('measure').measurements).toHaveLength(1)
    expect(map.plugin('measure').measurements[0]!.areaMetres2).toBeCloseTo(GRID_AREA_M2, 0)

    await map.destroy()
  })

  it('2. leaks nothing on removal', async () => {
    const baseline = await createTestMap({ config: { crs: { working: TM30 } } })
    const clean = baseline.debug.snapshot()
    await baseline.destroy()

    const map = await measureMap()
    await drawArea(map, [SW, SE, NE, NW])

    // Real state exists before we tear it down, or the assertion below proves nothing.
    expect(map.debug.snapshot()['features']).toBeGreaterThan(0)
    expect(map.debug.snapshot()['layers']).toBe(4)

    await map.remove('measure')

    // Back to a bare map: no listeners, no layers, no middleware, and — the one a
    // DisposableStore cannot do for you — no collections full of orphaned geometry.
    expect(map.debug.snapshot()).toEqual(clean)
    expect(map.tools.list()).toEqual([])
    expect(map.store.collections()).not.toContain(MEASURE_COLLECTION)

    await map.destroy()
  })

  it('3. round-trips: undoing a measurement restores the store to deep equality', async () => {
    const map = await measureMap()
    const executed: Command[] = []
    map.commands.onDidExecute((command) => executed.push(command))

    const before = map.store.snapshot()

    await drawArea(map, [SW, SE, NE, NW])
    expect(map.store.snapshot()).not.toEqual(before)

    // One gesture, one recorded command — the 200 transient rubber-band writes are not
    // in here, which is the point of marking them transient.
    expect(executed).toHaveLength(1)

    const ctx: CommandContext = { store: map.store, events: map.events }
    executed[0]!.undo(ctx)

    // Deep equality, no tolerance: geometry, labels, ids, meta, versions.
    expect(map.store.snapshot()).toEqual(before)
    expect(map.plugin('measure').measurements).toEqual([])

    // And redo puts it back under the same ids, so a label still points at its geometry.
    executed[0]!.execute(ctx)
    expect(map.plugin('measure').measurements).toHaveLength(1)

    await map.destroy()
  })
})

/* ========================================================================= */
/* A deliberately spherical area — the thing we are proving we do NOT do     */
/* ========================================================================= */

/**
 * Spherical excess on the authalic sphere: the same formula `@turf/area` uses.
 *
 * Written out here rather than imported so the comparison test is honest — it must
 * compare our planar answer against a *real* spherical one, not against another call
 * into the same code path.
 */
function sphericalArea(ring: readonly LngLat[]): number {
  const R = 6371008.8
  const rad = Math.PI / 180
  let total = 0

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!
    const b = ring[(i + 1) % ring.length]!
    total += (b[0] - a[0]) * rad * (2 + Math.sin(a[1] * rad) + Math.sin(b[1] * rad))
  }

  return Math.abs((total * R * R) / 2)
}
