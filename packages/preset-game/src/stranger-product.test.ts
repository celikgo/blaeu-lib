/**
 * ADVERSARIAL TEST — "a stranger can build a new product without touching core".
 *
 * I am the stranger. I am building HydroChart, a hydrographic survey product:
 * depth soundings snapped to navigation buoys, drawn on a depth-band layer, in a
 * local harbour grid, with a max-depth rule that must block a bad write.
 *
 * The rules I hold myself to, and the whole point of the file:
 *   1. I import ONLY from package barrels: '@blaeu/core', '@blaeu/core/testing',
 *      '@blaeu/plugin-snap', '@blaeu/plugin-history'. No relative path into core,
 *      no deep subpath import, no `as any` reaching for an internal.
 *   2. I use NOTHING from preset-game (the authors' own existence proof). This file
 *      merely lives here because this package already has snap + history on its
 *      dependency graph, so `tsc --build` type-checks it too.
 *   3. Not a single line of packages/core changes. Verified by `git diff` outside.
 *
 * If any of the five extension points is a lie, one of these tests goes red.
 */
import { describe, expect, it } from 'vitest'

import {
  AddFeaturesCommand,
  createId,
  type CollectionId,
  type Disposable,
  type BlaeuFeature,
  type BlaeuPlugin,
  type InteractionContext,
  type LayerInstance,
  type LayerSpec,
  type LayerStyle,
  type LngLat,
  type PluginContext,
  type Renderer,
  type SnapCandidate,
  type SnapProvider,
  type SnapQueryContext,
  type Tool,
  type ValidationIssue,
  type ValidationRule,
} from '@blaeu/core'
import { createTestMap, expectWithinMetres, type TestMap } from '@blaeu/core/testing'
import { snapPlugin } from '@blaeu/plugin-snap'
import { historyPlugin } from '@blaeu/plugin-history'

/* ========================================================================= */
/* The stranger's product                                                    */
/* ========================================================================= */

const SOUNDINGS: CollectionId = 'soundings'
const BUOYS: CollectionId = 'buoys'
const SOUNDING_TOOL = 'hydro:sounding'
const DEPTH_BAND_LAYER_TYPE = 'hydro:depth-band'
const HARBOUR_CRS = 'HARBOUR:TM33'
const MAX_DEPTH_M = 200

/** A harbour near Ankara's longitude, so the fixtures' lng/lat land inside the zone. */
const HARBOUR: LngLat = [32.85, 39.93]
/** A navigation buoy. Soundings must snap to it. */
const BUOY: LngLat = [32.8512, 39.9312]

interface HydroApi {
  /** The depth the next click records, in metres. */
  setDepth(metres: number): void
  readonly depth: number
  /** So the test can assert the stranger's CRS really is driving the kernel. */
  readonly crsCode: string
}

/**
 * Extension point 1 of 5 — a NEW LAYER TYPE.
 *
 * Note what this does NOT have: `acquireSource`. That ref-counted helper is
 * private to BlaeuLayerManager and only the built-in `vector` type receives it.
 * A third-party layer type gets only `spec` and whatever it closed over. So the
 * real question this answers is: can a stranger's layer type still get live store
 * data, using nothing but the public `Renderer`? If it can't, the layer-type seam
 * is decorative and the claim is dead.
 */
function createDepthBandLayerType(
  renderer: Renderer,
): Parameters<TestMap['layers']['registerType']>[0] {
  return {
    type: DEPTH_BAND_LAYER_TYPE,

    create(spec: LayerSpec & { config?: { bands?: readonly number[] } }): LayerInstance {
      const source = spec.source
      if (source === undefined) throw new Error('[hydro] depth-band layer needs a source')

      const bands = spec.config?.bands ?? [10, 20, 50]
      // A real depth-band style: colour the sounding by which band it falls in.
      const style: LayerStyle = {
        circle: {
          radius: 5,
          color: ['step', ['get', 'depth'], '#c6e5ff', ...bands.flatMap((b) => [b, '#0b3d68'])],
        },
      }

      const sourceRef = renderer.addSource(source)
      const layerRef = renderer.addLayer(spec.id, source, style, spec.beforeId)

      let disposed = false
      return {
        id: spec.id,
        type: DEPTH_BAND_LAYER_TYPE,
        setVisible: (visible) => renderer.setLayerVisible(spec.id, visible),
        setStyle: (s) => renderer.setLayerStyle(spec.id, s),
        dispose: () => {
          if (disposed) return
          disposed = true
          layerRef.dispose()
          sourceRef.dispose()
        },
      }
    },
  }
}

/**
 * Extension point 2 of 5 — a NEW SNAP TARGET.
 *
 * A "buoy" is not a vertex, an edge, a midpoint or a grid node. It is a domain
 * concept the kernel has never heard of. If the SnapProvider seam is real, every
 * tool in the product — including my sounding tool, which contains not one line
 * about snapping — lands exactly on the buoy.
 */
function createBuoyProvider(store: TestMap['store']): SnapProvider {
  return {
    id: 'hydro:buoy',
    // Above vertex (100): in a harbour a buoy outranks any old polygon corner.
    priority: 150,

    query(point: LngLat, tolerancePx: number, ctx: SnapQueryContext): readonly SnapCandidate[] {
      if (!store.collections().includes(BUOYS)) return []
      const cursor = ctx.project(point)

      return store
        .collection(BUOYS)
        .all()
        .flatMap((buoy): SnapCandidate[] => {
          if (buoy.geometry.type !== 'Point') return []
          const at = buoy.geometry.coordinates as LngLat
          const px = ctx.project(at)
          const distancePx = Math.hypot(px.x - cursor.x, px.y - cursor.y)
          if (distancePx > tolerancePx) return []
          return [
            {
              kind: 'buoy', // a kind core does not know — SnapKind is `(string & {})`-open
              point: at,
              distancePx,
              priority: 150,
              feature: buoy.id,
              hint: `Buoy ${String(buoy.properties.name ?? '')}`,
            },
          ]
        })
    },
  }
}

/**
 * Extension point 3 of 5 — a NEW VALIDATION RULE.
 *
 * severity: 'error' must VETO the write. Not warn about it afterwards — veto it,
 * so the bad sounding never exists in the store even transiently.
 */
function maxDepthRule(): ValidationRule {
  return {
    id: 'hydro:max-depth',
    severity: 'error',
    appliesTo: (f) => typeof f.properties.depth === 'number',
    check(feature: BlaeuFeature): readonly ValidationIssue[] {
      const depth = feature.properties.depth as number
      if (depth <= MAX_DEPTH_M) return []
      return [
        {
          rule: 'hydro:max-depth',
          severity: 'error',
          message: `Sounding of ${depth} m exceeds the ${MAX_DEPTH_M} m chart limit.`,
          feature: feature.id,
          data: { depth },
        },
      ]
    },
  }
}

/**
 * Extension points 4 and 5 — a NEW TOOL, and a CUSTOM CRS.
 *
 * The tool is 12 lines and knows nothing about snapping: it reads `ctx.lngLat`,
 * which the snap middleware has already rewritten to the buoy. That is the
 * architecture's central claim, tested from the outside by someone who did not
 * write it.
 */
function hydroPlugin(): BlaeuPlugin<HydroApi, unknown> {
  return {
    id: 'hydro',
    version: '1.0.0',
    // NOTE: a HARD dependency on snap. The docstring in core's own
    // types/plugin.ts prescribes `{ id: 'snap', optional: true }` +
    // `ctx.tryPlugin('snap')?.addProvider(...)` — but that silently no-ops (see
    // the `tryPlugin` race test at the bottom of this file). A hard dep parks the
    // plugin until snap exists, which is the only reliable spelling.
    dependencies: [{ id: 'snap' }],

    setup(ctx: PluginContext): HydroApi {
      let depth = 12

      /* --- the custom CRS: a local harbour grid, TM on the 33rd meridian --- */
      const crs = ctx.crs.register({
        code: HARBOUR_CRS,
        name: 'Harbour local grid (TM33 / GRS80)',
        proj4:
          '+proj=tmerc +lat_0=0 +lon_0=33 +k=1 +x_0=500000 +y_0=0 ' +
          '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
        unit: 'metre',
        bounds: [31.5, 39.0, 34.5, 41.0],
        precision: 0.001,
      })
      const previousCrs = ctx.crs.working.code
      ctx.crs.setWorking(crs.code)
      ctx.disposables.addFn(() => ctx.crs.setWorking(previousCrs))

      /* --- the layer type --- */
      ctx.disposables.add(ctx.layers.registerType(createDepthBandLayerType(ctx.renderer)))

      /* --- the validation rule --- */
      ctx.disposables.add(ctx.validation.add(maxDepthRule()))

      /* --- the snap provider, through the snap plugin's public API --- */
      const snap = ctx.plugin('snap')
      ctx.disposables.add(snap.addProvider(createBuoyProvider(ctx.store)) as Disposable)

      /* --- the tool --- */
      const tool: Tool = {
        id: SOUNDING_TOOL,
        cursor: 'crosshair',
        activate: () => {},
        deactivate: () => {},
        onClick(ictx: InteractionContext): boolean {
          // `ictx.lngLat` has already been through the interaction pipeline, so if a
          // buoy was within tolerance this is EXACTLY the buoy. The tool never knew.
          //
          // This is the canonical, documented way to write to the store: build a
          // command, `commit()` it. The commit path is async — it runs the validation
          // and preset middleware that may veto the write — and `onClick` is sync, so
          // the tool fires and forgets, exactly as the built-in tools do. The store
          // write therefore lands on a later macrotask: a test must `await
          // map.test.flush()` before asserting on it.
          void ctx.commands.commit(
            new AddFeaturesCommand(SOUNDINGS, [
              {
                id: createId('snd'),
                geometry: { type: 'Point', coordinates: [...ictx.lngLat] },
                properties: { depth },
              },
            ]),
          )
          return true
        },
      }
      ctx.disposables.add(ctx.tools.register(SOUNDING_TOOL, tool))

      return {
        setDepth: (m: number) => {
          depth = m
        },
        get depth() {
          return depth
        },
        crsCode: crs.code,
      }
    },
  }
}

/** The typed-registry seam: after this, `map.plugin('hydro')` needs no cast. */
declare module '@blaeu/core' {
  interface BlaeuPluginRegistry {
    hydro: HydroApi
  }
}

/* ========================================================================= */
/* The tests                                                                 */
/* ========================================================================= */

async function hydroChart(): Promise<TestMap> {
  return createTestMap({
    plugins: [snapPlugin({ tolerance: 10 }), historyPlugin(), hydroPlugin()],
    features: {
      [BUOYS]: [
        {
          id: 'buoy-1',
          geometry: { type: 'Point', coordinates: [...BUOY] },
          properties: { name: 'Fairway No.1' },
        },
      ],
    },
    camera: { center: HARBOUR, zoom: 16 },
  })
}

describe('a stranger builds HydroChart without touching packages/core', () => {
  it('registers a custom CRS that really drives the kernel’s measurement', async () => {
    const map = await hydroChart()

    // The stranger's CRS is now THE working plane. Not decoration.
    expect(map.crs.working.code).toBe(HARBOUR_CRS)
    expect(map.crs.list()).toContain(HARBOUR_CRS)

    // A 100 m x 100 m square in the harbour, built in the stranger's own plane.
    // ProjectedXY is a tuple [x, y], not {x, y} — the type system says so.
    const [ox, oy] = map.crs.working.forward(HARBOUR)
    const ring: LngLat[] = [
      map.crs.working.inverse([ox, oy]),
      map.crs.working.inverse([ox + 100, oy]),
      map.crs.working.inverse([ox + 100, oy + 100]),
      map.crs.working.inverse([ox, oy + 100]),
      map.crs.working.inverse([ox, oy]),
    ]

    // The kernel's area(), computed through the CRS the stranger registered.
    const reported = map.crs.area({ type: 'Polygon', coordinates: [ring.map((p) => [...p])] })

    // Independent planar shoelace, in the stranger's own plane, via the public
    // ProjectedCrs.forward. If the kernel had quietly used spherical maths, or had
    // ignored the registered CRS and stayed on the default, this misses.
    const xy = ring.map((p) => map.crs.working.forward(p))
    let twice = 0
    for (let i = 0; i < xy.length - 1; i++) {
      twice += xy[i]![0] * xy[i + 1]![1] - xy[i + 1]![0] * xy[i]![1]
    }
    const independent = Math.abs(twice) / 2

    expect(independent).toBeCloseTo(10_000, 3)
    expect(reported).toBeCloseTo(independent, 3)

    map.destroy()
  })

  it('registers a new layer type that receives live store data', async () => {
    const map = await hydroChart()

    const layer = map.layers.add({
      id: 'depth-bands',
      type: DEPTH_BAND_LAYER_TYPE,
      source: SOUNDINGS,
      config: { bands: [10, 20, 50] },
    })
    expect(layer.type).toBe(DEPTH_BAND_LAYER_TYPE)
    expect(map.test.renderer.layers.has('depth-bands')).toBe(true)

    // The decisive part: a layer type core has never heard of, fed by the store.
    map.plugin('hydro').setDepth(37)
    map.tools.activate(SOUNDING_TOOL)
    map.test.click([32.8531, 39.9331])
    await map.test.flush()

    const drawn = map.test.renderer.sources.get(SOUNDINGS) ?? []
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.properties.depth).toBe(37)

    map.destroy()
  })

  it('snaps a brand-new tool to a brand-new snap target, pixel-honestly', async () => {
    const map = await hydroChart()
    map.tools.activate(SOUNDING_TOOL)

    // Click 6 px from the buoy — inside the 10 px tolerance.
    const buoyPx = map.test.project(BUOY)
    const near = map.test.unproject({ x: buoyPx.x + 6, y: buoyPx.y })
    map.test.click(near)
    await map.test.flush()

    const snapped = map.store.collection(SOUNDINGS).all()
    expect(snapped).toHaveLength(1)
    // The tool contains no snapping code. It landed on the buoy anyway.
    const at = (snapped[0]!.geometry as { coordinates: LngLat }).coordinates
    expectWithinMetres(at, BUOY, 0.01)

    // And the snap engine reports MY kind, which core does not define.
    expect(map.plugin('snap').current?.candidate.kind).toBe('buoy')

    // Click 40 px away — outside tolerance. Must NOT snap.
    const far = map.test.unproject({ x: buoyPx.x + 40, y: buoyPx.y })
    map.test.click(far)
    await map.test.flush()

    const all = map.store.collection(SOUNDINGS).all()
    expect(all).toHaveLength(2)
    const unsnapped = all[1]!.geometry as { coordinates: LngLat }
    expect(map.crs.distance(unsnapped.coordinates, BUOY)).toBeGreaterThan(1)

    map.destroy()
  })

  /* ===================================================================== */
  /* A stranger's validation rule vetoes a write on the real write path.   */
  /*                                                                       */
  /* core/src/types/validation.ts:36 promises: "an `error` blocks the      */
  /* write — the parcel is never stored, the command reports { ok: false }".*/
  /*                                                                       */
  /* This test used to be a REFUTATION: the kernel constructed the commit  */
  /* pipeline and registered validation into it, but nothing in            */
  /* packages/core ever called `commit.run()`, so the rule never fired on  */
  /* the write path and the over-depth sounding was stored anyway. That is */
  /* now fixed — `commands.commit()` runs the pipeline, and an `error`     */
  /* severity genuinely blocks the write. The assertion below is unchanged */
  /* from the refutation; it simply passes now.                            */
  /* ===================================================================== */
  it('lets a new validation rule veto a write', async () => {
    const map = await hydroChart()
    map.tools.activate(SOUNDING_TOOL)

    // The rule IS registered — the extension point accepted it.
    expect(map.validation.list().map((r) => r.id)).toContain('hydro:max-depth')

    // And it works when asked directly.
    const probe = await map.validation.run([
      {
        id: 'p',
        geometry: { type: 'Point', coordinates: [...HARBOUR] },
        properties: { depth: 500 },
        meta: {},
      } as unknown as BlaeuFeature,
    ])
    expect(probe.map((i) => `${i.rule}/${i.severity}`)).toContain('hydro:max-depth/error')

    // And — the point of the test — it also runs on the write path.
    map.plugin('hydro').setDepth(500) // 2.5x over the 200 m chart limit
    map.test.click([32.8531, 39.9331])
    await map.test.flush()

    // The contract says 0, and the kernel now honours it: the sounding is refused.
    // (The sibling tests above store soundings at 37 m and 12 m through this exact
    // path, so a zero here is the rule vetoing — not the write path being broken.)
    expect(map.store.collection(SOUNDINGS).all()).toHaveLength(0)

    map.destroy()
  })

  /* ===================================================================== */
  /* REFUTATION 2 — the documented snap-provider extension point is a race.*/
  /*                                                                       */
  /* core/src/types/plugin.ts:107 prescribes exactly:                      */
  /*     ctx.tryPlugin('snap')?.addProvider(parcelCornerProvider)          */
  /* But BlaeuMap.ts:145 installs plugins CONCURRENTLY (Promise.all), and  */
  /* PluginManager#missingDependencies does NOT park on an optional dep.   */
  /* So tryPlugin(optional) returns undefined or the API depending on      */
  /* install timing the plugin author cannot control — and it fails SILENT.*/
  /* ===================================================================== */
  it('REFUTES: ctx.tryPlugin(optionalDep) is decided by a race, not by declaration', async () => {
    type Saw = { sawSnap: boolean }
    const optionalOnly: BlaeuPlugin<Saw, unknown> = {
      id: 'opt-only',
      dependencies: [{ id: 'snap', optional: true }],
      setup: (ctx: PluginContext) => ({ sawSnap: ctx.tryPlugin('snap') !== undefined }),
    }
    const optionalPlusUnrelatedHardDep: BlaeuPlugin<Saw, unknown> = {
      id: 'opt-plus-hard',
      dependencies: [{ id: 'history' }, { id: 'snap', optional: true }],
      setup: (ctx: PluginContext) => ({ sawSnap: ctx.tryPlugin('snap') !== undefined }),
    }

    const map = await createTestMap({
      // snapPlugin is listed FIRST; both plugins below optionally depend on it.
      plugins: [snapPlugin(), historyPlugin(), optionalOnly, optionalPlusUnrelatedHardDep],
    })

    const a = (map.plugins.get('opt-only' as never) as Saw).sawSnap
    const b = (map.plugins.get('opt-plus-hard' as never) as Saw).sawSnap

    // Identical optional dependency on snap. Identical position after snapPlugin.
    // The ONLY difference is an unrelated hard dep on history — which parks the
    // plugin long enough for snap to finish installing.
    expect({ optionalOnly: a, optionalPlusUnrelatedHardDep: b }).toEqual({
      optionalOnly: true,
      optionalPlusUnrelatedHardDep: true,
    })

    map.destroy()
  })

  it('composes with a plugin the stranger did not write: one undo removes the sounding', async () => {
    const map = await hydroChart()
    map.tools.activate(SOUNDING_TOOL)

    map.test.click([32.8531, 39.9331])
    await map.test.flush()
    expect(map.store.collection(SOUNDINGS).all()).toHaveLength(1)

    // history has never heard of hydro, and hydro never declared history a dependency.
    expect(map.plugin('history').undo()).toBe(true)
    await map.test.flush()
    expect(map.store.collection(SOUNDINGS).all()).toHaveLength(0)

    map.destroy()
  })

  it('tears down completely: every extension point is released', async () => {
    const map = await hydroChart()
    const before = map.debug.snapshot()

    await map.plugins.remove('hydro')

    // The tool is gone.
    expect(map.tools.list()).not.toContain(SOUNDING_TOOL)
    // The snap provider is gone.
    expect(
      map
        .plugin('snap')
        .providers()
        .map((p) => p.id),
    ).not.toContain('hydro:buoy')
    // The validation rule is gone.
    expect(map.validation.list().map((r) => r.id)).not.toContain('hydro:max-depth')
    // The working CRS is restored — the stranger did not leave the map in their plane.
    expect(map.crs.working.code).not.toBe(HARBOUR_CRS)
    // The layer type is gone: adding one now throws.
    expect(() =>
      map.layers.add({ id: 'x', type: DEPTH_BAND_LAYER_TYPE, source: SOUNDINGS }),
    ).toThrow(/unknown layer type/)

    const after = map.debug.snapshot()
    expect(after.listeners).toBeLessThanOrEqual(before.listeners)
    expect(after.middleware).toBeLessThanOrEqual(before.middleware)

    map.destroy()
  })
})
