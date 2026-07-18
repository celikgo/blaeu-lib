import { describe, expect, it, vi } from 'vitest'
import { MapLibreRenderer } from './MapLibreRenderer.js'
import { createRasterLayerType } from '../layers/rasterLayerType.js'
import type { LayerStyle } from '../types/renderer.js'
import type { ResolvedLayerSpec } from '../types/extensions.js'
import type { RasterLayerConfig } from '../layers/rasterLayerType.js'

/* ------------------------------------------------------------------------- */
/* A faithful, GPU-free stand-in for maplibre-gl's `Map`.                     */
/*                                                                            */
/* This is the first test that drives the real MapLibreRenderer — the whole  */
/* reason the "raster layer throws on every add" critical stayed hidden is    */
/* that nothing here ever exercised the renderer's own translation. The fake  */
/* reproduces the two MapLibre semantics that make the bug real: `addLayer`   */
/* rejects a layer whose source is not on the map yet, and `setStyle` wipes   */
/* every source and layer.                                                    */
/* ------------------------------------------------------------------------- */

const { FakeMapLibreMap } = vi.hoisted(() => {
  interface FakeLayer {
    id: string
    type: string
    source?: string
    paint: Record<string, unknown>
    layout: Record<string, unknown>
    [key: string]: unknown
  }
  interface FakeSource {
    type: string
    def: Record<string, unknown>
    setData: (data: unknown) => void
  }

  class FakeMapLibreMap {
    readonly sources = new Map<string, FakeSource>()
    readonly layers = new Map<string, FakeLayer>()
    order: string[] = []
    readonly lastData = new Map<string, unknown>()
    removed = false
    /** Set to a layer type to make `addLayer` reject it — for the rollback test. */
    failLayerType: string | undefined

    constructor(_options: Record<string, unknown>) {}

    loaded(): boolean {
      return true
    }
    isStyleLoaded(): boolean {
      return true
    }
    on(): { unsubscribe: () => void } {
      return { unsubscribe: () => {} }
    }
    getCanvas(): { style: Record<string, string> } {
      return { style: {} }
    }

    addSource(id: string, def: Record<string, unknown>): void {
      if (this.sources.has(id)) throw new Error(`fake maplibre: source "${id}" already exists`)
      this.sources.set(id, {
        type: String(def.type),
        def,
        setData: (data: unknown) => this.lastData.set(id, data),
      })
    }
    getSource(id: string): FakeSource | undefined {
      return this.sources.get(id)
    }
    removeSource(id: string): void {
      for (const layer of this.layers.values()) {
        if (layer.source === id) {
          throw new Error(`fake maplibre: source "${id}" still used by layer "${layer.id}"`)
        }
      }
      this.sources.delete(id)
    }

    addLayer(spec: FakeLayer, before?: string): void {
      if (this.layers.has(spec.id)) throw new Error(`fake maplibre: layer "${spec.id}" exists`)
      if (this.failLayerType !== undefined && spec.type === this.failLayerType) {
        throw new Error(`fake maplibre: refusing a "${spec.type}" layer`)
      }
      if (spec.source !== undefined && !this.sources.has(spec.source)) {
        throw new Error(
          `fake maplibre: layer "${spec.id}" references missing source "${spec.source}"`,
        )
      }
      this.layers.set(spec.id, {
        ...spec,
        paint: { ...(spec.paint ?? {}) },
        layout: { ...(spec.layout ?? {}) },
      })
      const at = before !== undefined ? this.order.indexOf(before) : -1
      if (at < 0) this.order.push(spec.id)
      else this.order.splice(at, 0, spec.id)
    }
    getLayer(id: string): FakeLayer | undefined {
      return this.layers.get(id)
    }
    removeLayer(id: string): void {
      if (!this.layers.has(id)) throw new Error(`fake maplibre: no layer "${id}" to remove`)
      this.layers.delete(id)
      this.order = this.order.filter((x) => x !== id)
    }
    setPaintProperty(id: string, key: string, value: unknown): void {
      const layer = this.layers.get(id)
      if (!layer) throw new Error(`fake maplibre: no layer "${id}"`)
      if (value === undefined) delete layer.paint[key]
      else layer.paint[key] = value
    }
    setLayoutProperty(id: string, key: string, value: unknown): void {
      const layer = this.layers.get(id)
      if (!layer) throw new Error(`fake maplibre: no layer "${id}"`)
      if (value === undefined) delete layer.layout[key]
      else layer.layout[key] = value
    }
    setStyle(_style: unknown, _options: unknown): void {
      // A full replacement throws away every source and layer — the behaviour the
      // renderer's re-materialise exists to survive.
      this.sources.clear()
      this.layers.clear()
      this.order = []
    }
    getCenter(): { lng: number; lat: number } {
      return { lng: 0, lat: 0 }
    }
    getZoom(): number {
      return 0
    }
    getBearing(): number {
      return 0
    }
    getPitch(): number {
      return 0
    }
    remove(): void {
      this.removed = true
    }
  }

  return { FakeMapLibreMap }
})

// `maplibre-gl` ships a UMD bundle whose namespace arrives under `default`; the
// renderer unwraps it with `namespace.default ?? namespace`. Mirror that shape so the
// interop dance in `loadMapLibre` is exercised, not bypassed.
vi.mock('maplibre-gl', () => ({ default: { Map: FakeMapLibreMap }, Map: FakeMapLibreMap }))

type FakeMap = InstanceType<typeof FakeMapLibreMap>

const TILES = ['https://tile.example/{z}/{x}/{y}.png']

const RASTER_STYLE: LayerStyle = {
  native: {
    type: 'raster',
    source: { type: 'raster', tiles: TILES, tileSize: 512, attribution: '© Example' },
  },
}

async function mountRenderer(): Promise<{ renderer: MapLibreRenderer; map: FakeMap }> {
  const renderer = new MapLibreRenderer()
  await renderer.mount({} as unknown as HTMLElement)
  return { renderer, map: renderer.getNative<FakeMap>() }
}

function rasterSpec(
  overrides: Partial<ResolvedLayerSpec & { config?: RasterLayerConfig }> = {},
): ResolvedLayerSpec & { config?: RasterLayerConfig } {
  return {
    id: 'basemap',
    type: 'raster',
    config: { tiles: TILES, tileSize: 512, attribution: '© Example' },
    ...overrides,
  }
}

describe('MapLibreRenderer — the raster layer critical', () => {
  it('materialises a raster layer as its own tile source + layer (the audit critical)', async () => {
    const { renderer, map } = await mountRenderer()

    // The exact path a `map.layers.add({ type: 'raster' })` takes: the layer type
    // hands the renderer a style whose `native.source` is a tile-source definition.
    createRasterLayerType(renderer).create(rasterSpec())

    // The source arrived as a raster tile source, not a GeoJSON one — and no
    // `addSource()` (the BlaeuFeature primitive) was ever needed.
    const source = map.getSource('basemap')
    expect(source?.type).toBe('raster')
    expect(source?.def).toMatchObject({ type: 'raster', tiles: TILES, tileSize: 512 })

    // The layer draws from that source. Before the fix this line was never reached:
    // addLayer threw "references source … which does not exist".
    const layer = map.getLayer('basemap::raster')
    expect(layer?.type).toBe('raster')
    expect(layer?.source).toBe('basemap')
    expect(renderer.nativeLayerIds('basemap')).toEqual(['basemap::raster'])
  })

  it('drops native.source/native.type from the layer spec, keeping paint/layout', async () => {
    const { renderer, map } = await mountRenderer()
    renderer.addLayer('basemap', 'basemap', {
      native: { ...RASTER_STYLE.native, paint: { 'raster-opacity': 0.6 } },
    })

    const layer = map.getLayer('basemap::raster')
    expect(layer?.paint).toEqual({ 'raster-opacity': 0.6 })
    // `source` on the layer is the id string, never the inline definition object.
    expect(layer?.source).toBe('basemap')
    expect(layer).not.toHaveProperty('tiles')
  })

  it('restyles a raster layer in place without dropping its tile source', async () => {
    const { renderer, map } = await mountRenderer()
    const instance = createRasterLayerType(renderer).create(rasterSpec())

    instance.setStyle({ native: { paint: { 'raster-opacity': 0.5 } } })

    expect(map.getSource('basemap')?.type).toBe('raster')
    expect(map.getLayer('basemap::raster')?.paint).toMatchObject({ 'raster-opacity': 0.5 })
  })

  it('tears down both the layer and its tile source on dispose', async () => {
    const { renderer, map } = await mountRenderer()
    const instance = createRasterLayerType(renderer).create(rasterSpec())

    instance.dispose()

    expect(map.getLayer('basemap::raster')).toBeUndefined()
    expect(map.getSource('basemap')).toBeUndefined()
  })

  it('re-materialises the raster source + layer across a basemap swap', async () => {
    const { renderer, map } = await mountRenderer()
    createRasterLayerType(renderer).create(rasterSpec())

    // A theme change swaps the basemap; MapLibre's setStyle wipes everything.
    await renderer.setBasemap({ version: 8, sources: {}, layers: [] })

    // The orthophoto must survive the swap, source and all — not vanish.
    expect(map.getSource('basemap')?.type).toBe('raster')
    const layer = map.getLayer('basemap::raster')
    expect(layer?.type).toBe('raster')
    expect(layer?.source).toBe('basemap')
  })

  it('rolls back a source it created when the layer add fails', async () => {
    const { renderer, map } = await mountRenderer()
    map.failLayerType = 'raster'

    expect(() => renderer.addLayer('basemap', 'basemap', RASTER_STYLE)).toThrow(/refusing/)

    // No orphan tile source left behind for a layer that never made it onto the map.
    expect(map.getSource('basemap')).toBeUndefined()
    expect(renderer.nativeLayerIds('basemap')).toEqual([])

    // The bookkeeping must be rolled back too, not just the live map: a later basemap
    // swap must not re-materialise a phantom source no layer draws from.
    map.failLayerType = undefined
    await renderer.setBasemap({ version: 8, sources: {}, layers: [] })
    expect(map.getSource('basemap')).toBeUndefined()
  })

  it('still rejects a native layer that names a source that does not exist', async () => {
    const { renderer } = await mountRenderer()
    expect(() => renderer.addLayer('x', 'nope', { native: { type: 'raster' } })).toThrow(
      /references source "nope", which does not exist/,
    )
  })
})

describe('MapLibreRenderer — vector path is unaffected', () => {
  it('adds a vector layer over a pre-registered GeoJSON source', async () => {
    const { renderer, map } = await mountRenderer()
    renderer.addSource('parcels', [])
    renderer.addLayer('parcels', 'parcels', { fill: { color: '#ff0000' } })

    expect(map.getSource('parcels')?.type).toBe('geojson')
    const layer = map.getLayer('parcels::fill')
    expect(layer?.type).toBe('fill')
    expect(layer?.paint).toMatchObject({ 'fill-color': '#ff0000' })
  })

  it('still rejects a vector layer whose source was never registered', async () => {
    const { renderer } = await mountRenderer()
    expect(() => renderer.addLayer('parcels', 'parcels', { fill: { color: '#f00' } })).toThrow(
      /references source "parcels", which does not exist/,
    )
  })

  it('still rejects a style that draws nothing', async () => {
    const { renderer } = await mountRenderer()
    renderer.addSource('parcels', [])
    expect(() => renderer.addLayer('parcels', 'parcels', {})).toThrow(/nothing to draw/)
  })
})

describe('MapLibreRenderer — shared tile sources are ref-counted', () => {
  // Two raster layers deliberately pointed at one tile set — the affordance
  // rasterLayerType documents ("several layers at one tile set"). Disposing one must
  // not silently take the other with it, the hazard the adversarial review surfaced.
  function twoSharedLayers(renderer: MapLibreRenderer) {
    const type = createRasterLayerType(renderer)
    const a = type.create(rasterSpec({ id: 'ortho-a', source: 'ortho' }))
    const b = type.create(rasterSpec({ id: 'ortho-b', source: 'ortho' }))
    return { a, b }
  }

  it('adds both layers over one shared source', async () => {
    const { renderer, map } = await mountRenderer()
    twoSharedLayers(renderer)

    expect(map.getSource('ortho')?.type).toBe('raster')
    expect(map.getLayer('ortho-a::raster')?.source).toBe('ortho')
    expect(map.getLayer('ortho-b::raster')?.source).toBe('ortho')
  })

  it('disposing one shared-source layer leaves the sibling and the source intact', async () => {
    const { renderer, map } = await mountRenderer()
    const { a } = twoSharedLayers(renderer)

    a.dispose()

    // The disposed layer is gone; the sibling and the shared source survive.
    expect(map.getLayer('ortho-a::raster')).toBeUndefined()
    expect(map.getLayer('ortho-b::raster')?.source).toBe('ortho')
    expect(map.getSource('ortho')?.type).toBe('raster')
  })

  it('drops the shared source only when the last layer using it is gone', async () => {
    const { renderer, map } = await mountRenderer()
    const { a, b } = twoSharedLayers(renderer)

    a.dispose()
    expect(map.getSource('ortho')?.type).toBe('raster')

    b.dispose()
    expect(map.getLayer('ortho-b::raster')).toBeUndefined()
    expect(map.getSource('ortho')).toBeUndefined()
  })

  it('re-materialises a shared source once across a basemap swap and survives teardown', async () => {
    const { renderer, map } = await mountRenderer()
    const { a, b } = twoSharedLayers(renderer)

    await renderer.setBasemap({ version: 8, sources: {}, layers: [] })
    expect(map.getSource('ortho')?.type).toBe('raster')
    expect(map.getLayer('ortho-a::raster')?.source).toBe('ortho')
    expect(map.getLayer('ortho-b::raster')?.source).toBe('ortho')

    // The ref count must survive the swap: it still takes both disposes to drop it.
    a.dispose()
    expect(map.getSource('ortho')?.type).toBe('raster')
    b.dispose()
    expect(map.getSource('ortho')).toBeUndefined()
  })

  it('rejects a raster source id already taken by a store (GeoJSON) source', async () => {
    const { renderer } = await mountRenderer()
    renderer.addSource('parcels', []) // a vector/store source

    expect(() =>
      createRasterLayerType(renderer).create(rasterSpec({ id: 'x', source: 'parcels' })),
    ).toThrow(/already exists and is not a tile source/)
  })

  // The ref count must key on the *tracked* source, not on whether a given add supplied
  // an inline object definition — else a layer that shares by string id or bare
  // reference is a free rider, and releasing the counted holder sweeps it away. These
  // two exercise the low-level renderer.addLayer directly (a plugin's path), since the
  // shipped raster layer type always emits an inline object source.
  it('ref-counts a shared tile source referenced by string id', async () => {
    const { renderer, map } = await mountRenderer()
    renderer.addLayer('a', 'shared', {
      native: { type: 'raster', source: { type: 'raster', tiles: TILES } },
    })
    renderer.addLayer('b', 'shared', { native: { type: 'raster', source: 'shared' } })

    // Release layer a the way a raster layer's dispose does: remove the layer, then the
    // source. Layer b, though it never supplied a definition, must keep the tiles.
    renderer.removeLayer('a')
    renderer.removeSource('shared')
    expect(map.getLayer('b::raster')?.source).toBe('shared')
    expect(map.getSource('shared')?.type).toBe('raster')

    renderer.removeLayer('b')
    renderer.removeSource('shared')
    expect(map.getSource('shared')).toBeUndefined()
  })

  it('ref-counts a shared tile source a second layer references with no source key', async () => {
    const { renderer, map } = await mountRenderer()
    renderer.addLayer('a', 'shared', {
      native: { type: 'raster', source: { type: 'raster', tiles: TILES } },
    })
    // A translucent overlay over the same tiles — no `source` key at all.
    renderer.addLayer('b', 'shared', {
      native: { type: 'raster', paint: { 'raster-opacity': 0.4 } },
    })

    renderer.removeLayer('a')
    renderer.removeSource('shared')
    expect(map.getLayer('b::raster')?.source).toBe('shared')
    expect(map.getSource('shared')?.type).toBe('raster')

    renderer.removeLayer('b')
    renderer.removeSource('shared')
    expect(map.getSource('shared')).toBeUndefined()
  })
})

describe('MapLibreRenderer — visibility survives a basemap swap', () => {
  it('keeps a hidden raster layer hidden after re-materialisation', async () => {
    const { renderer, map } = await mountRenderer()
    const instance = createRasterLayerType(renderer).create(rasterSpec())
    instance.setVisible(false)

    await renderer.setBasemap({ version: 8, sources: {}, layers: [] })

    // #rematerialise must re-assert visibility, or a theme change un-hides the layer.
    expect(map.getLayer('basemap::raster')?.layout).toMatchObject({ visibility: 'none' })
  })
})
