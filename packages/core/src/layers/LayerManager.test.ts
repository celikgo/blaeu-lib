import { beforeEach, describe, expect, it } from 'vitest'
import { FlexiEventBus } from '../events/EventBus.js'
import { FlexiLayerManager } from './LayerManager.js'
import type { Bbox, Disposable, FeatureId, LngLat, ScreenPoint } from '../types/common.js'
import type { FlexiFeature } from '../types/feature.js'
import type { Camera, CameraOptions, LayerStyle, Renderer } from '../types/renderer.js'
import type { Collection, FeatureStore, StoreChange } from '../types/store.js'

/* ------------------------------------------------------------------------- */
/* Stubs. Local on purpose: the shared FakeRenderer is a testing-package       */
/* concern, and this suite must not be able to pass because of a bug in it.    */
/* ------------------------------------------------------------------------- */

interface LayerCall {
  readonly id: string
  readonly source: string
  readonly style: LayerStyle
  readonly beforeId: string | undefined
}

class StubRenderer implements Renderer {
  readonly kind = 'stub'

  readonly sources = new Map<string, readonly FlexiFeature[]>()
  readonly layers: LayerCall[] = []
  readonly addSourceCalls: string[] = []
  readonly removeSourceCalls: string[] = []
  readonly setDataCalls: { source: string; features: readonly FlexiFeature[] }[] = []
  readonly visible = new Map<string, boolean>()

  resolver: ((id: FeatureId) => FlexiFeature | undefined) | undefined
  /** Optional on the `Renderer` contract, so it is an own property, not a method. */
  setFeatureResolver?: (resolve: (id: FeatureId) => FlexiFeature | undefined) => void

  constructor(options: { featureResolver?: boolean } = {}) {
    if (options.featureResolver !== false) {
      this.setFeatureResolver = (resolve) => {
        this.resolver = resolve
      }
    }
  }

  setDataCallsFor(source: string): number {
    return this.setDataCalls.filter((c) => c.source === source).length
  }

  mount(): Promise<void> {
    return Promise.resolve()
  }

  setData(sourceId: string, features: readonly FlexiFeature[]): void {
    this.setDataCalls.push({ source: sourceId, features })
    this.sources.set(sourceId, features)
  }

  addSource(sourceId: string, features: readonly FlexiFeature[] = []): Disposable {
    this.addSourceCalls.push(sourceId)
    this.sources.set(sourceId, features)
    return { dispose: () => this.removeSource(sourceId) }
  }

  removeSource(sourceId: string): void {
    this.removeSourceCalls.push(sourceId)
    this.sources.delete(sourceId)
  }

  addLayer(layerId: string, sourceId: string, style: LayerStyle, beforeId?: string): Disposable {
    this.layers.push({ id: layerId, source: sourceId, style, beforeId })
    return { dispose: () => this.removeLayer(layerId) }
  }

  removeLayer(layerId: string): void {
    const i = this.layers.findIndex((l) => l.id === layerId)
    if (i < 0) throw new Error(`stub renderer: no layer "${layerId}" to remove`)
    this.layers.splice(i, 1)
    this.visible.delete(layerId)
  }

  setLayerStyle(layerId: string, style: LayerStyle): void {
    const i = this.layers.findIndex((l) => l.id === layerId)
    const found = this.layers[i]
    if (!found) throw new Error(`stub renderer: no layer "${layerId}" to style`)
    this.layers[i] = { ...found, style }
  }

  setLayerVisible(layerId: string, visible: boolean): void {
    this.visible.set(layerId, visible)
  }

  project(lngLat: LngLat): ScreenPoint {
    return { x: lngLat[0], y: lngLat[1] }
  }
  unproject(p: ScreenPoint): LngLat {
    return [p.x, p.y]
  }
  getCamera(): Camera {
    return { center: [0, 0], zoom: 0, bearing: 0, pitch: 0 }
  }
  setCamera(_options: CameraOptions): void {}
  fitBounds(_bbox: Bbox): void {}
  queryAt(): readonly FlexiFeature[] {
    return []
  }
  queryInBox(): readonly FlexiFeature[] {
    return []
  }
  onPointer(): Disposable {
    return { dispose: () => {} }
  }
  onCamera(): Disposable {
    return { dispose: () => {} }
  }
  setCursor(_cursor: string): void {}
  getNative<T = unknown>(): T {
    return undefined as T
  }
  destroy(): void {}
}

class StubStore {
  readonly #collections = new Map<string, FlexiFeature[]>()
  readonly #handlers: ((change: StoreChange) => void)[] = []

  collections(): readonly string[] {
    return [...this.#collections.keys()]
  }

  collection(id: string): Collection {
    const features = this.#collections.get(id) ?? []
    return {
      id,
      size: features.length,
      all: () => features,
    } as unknown as Collection
  }

  find(id: FeatureId): FlexiFeature | undefined {
    for (const features of this.#collections.values()) {
      const found = features.find((f) => f.id === id)
      if (found) return found
    }
    return undefined
  }

  onChange(handler: (change: StoreChange) => void): Disposable {
    this.#handlers.push(handler)
    return {
      dispose: () => {
        const i = this.#handlers.indexOf(handler)
        if (i >= 0) this.#handlers.splice(i, 1)
      },
    }
  }

  /* --- test helpers --- */

  seed(collection: string, features: FlexiFeature[]): void {
    this.#collections.set(collection, features)
  }

  /** One store change, as a command would emit it. */
  touch(collection: string, feature: FlexiFeature): void {
    const features = this.#collections.get(collection) ?? []
    this.#collections.set(collection, [...features.filter((f) => f.id !== feature.id), feature])
    for (const h of [...this.#handlers]) {
      h({ kind: 'update', collection, features: [feature], previous: [feature] })
    }
  }

  asStore(): FeatureStore {
    return this as unknown as FeatureStore
  }
}

function feature(id: string, collection: string, hidden = false): FlexiFeature {
  return {
    id,
    geometry: { type: 'Point', coordinates: [32.85, 39.93] },
    properties: {},
    meta: {
      collection,
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      ...(hidden ? { hidden: true } : {}),
    },
  }
}

/** Lets every already-queued microtask (i.e. our coalesced flush) drain. */
function tick(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}

/* ------------------------------------------------------------------------- */

describe('FlexiLayerManager', () => {
  let renderer: StubRenderer
  let store: StubStore
  let events: FlexiEventBus
  let layers: FlexiLayerManager

  beforeEach(() => {
    renderer = new StubRenderer()
    store = new StubStore()
    events = new FlexiEventBus()
    layers = new FlexiLayerManager(renderer, store.asStore(), events)
  })

  it('ships the vector and raster types', () => {
    expect(() => layers.add({ id: 'l', type: 'nope' })).toThrow(/unknown layer type "nope"/)
    expect(() => layers.add({ id: 'l', type: 'nope' })).toThrow(/\[vector, raster\]/)
  })

  describe('vector', () => {
    it('creates the source from the store and a layer with the given style', () => {
      store.seed('parcels', [feature('a', 'parcels'), feature('b', 'parcels')])

      const layer = layers.add({
        id: 'parcels-fill',
        type: 'vector',
        source: 'parcels',
        style: { fill: { color: '#f00' } },
      })

      expect(layer.type).toBe('vector')
      expect(renderer.addSourceCalls).toEqual(['parcels'])
      expect(renderer.sources.get('parcels')).toHaveLength(2)
      expect(renderer.layers).toEqual([
        {
          id: 'parcels-fill',
          source: 'parcels',
          style: { fill: { color: '#f00' } },
          beforeId: undefined,
        },
      ])
    })

    it('never sends hidden features to the renderer', () => {
      store.seed('parcels', [feature('a', 'parcels'), feature('b', 'parcels', true)])
      layers.add({ id: 'fill', type: 'vector', source: 'parcels' })

      expect(renderer.sources.get('parcels')?.map((f) => f.id)).toEqual(['a'])
    })

    it('shares one ref-counted source between layers over the same collection', () => {
      store.seed('parcels', [feature('a', 'parcels')])

      layers.add({ id: 'fill', type: 'vector', source: 'parcels' })
      layers.add({ id: 'outline', type: 'vector', source: 'parcels' })

      expect(renderer.addSourceCalls).toEqual(['parcels'])

      layers.remove('fill')
      expect(renderer.sources.has('parcels')).toBe(true) // 'outline' still needs it

      layers.remove('outline')
      expect(renderer.removeSourceCalls).toEqual(['parcels'])
    })

    it('demands a source, and says so', () => {
      expect(() => layers.add({ id: 'fill', type: 'vector' })).toThrow(/has no "source"/)
    })

    it('applies visible:false at creation', () => {
      layers.add({ id: 'fill', type: 'vector', source: 'parcels', visible: false })
      expect(renderer.visible.get('fill')).toBe(false)
    })
  })

  describe('raster', () => {
    it('passes the tile config through style.native and touches no store source', () => {
      layers.add({
        id: 'basemap',
        type: 'raster',
        config: {
          tiles: ['https://tile.example/{z}/{x}/{y}.png'],
          tileSize: 512,
          attribution: '© Example',
        },
      })

      expect(renderer.addSourceCalls).toEqual([])
      expect(renderer.layers[0]?.style.native).toEqual({
        type: 'raster',
        source: {
          type: 'raster',
          tiles: ['https://tile.example/{z}/{x}/{y}.png'],
          tileSize: 512,
          attribution: '© Example',
        },
      })
    })

    it('rejects a tile-less raster layer', () => {
      expect(() => layers.add({ id: 'basemap', type: 'raster' })).toThrow(/config\.tiles/)
      expect(() => layers.add({ id: 'basemap', type: 'raster', config: { tiles: [] } })).toThrow(
        /config\.tiles/,
      )
    })

    it('keeps the tile source when the layer is restyled', () => {
      const layer = layers.add({
        id: 'basemap',
        type: 'raster',
        config: { tiles: ['https://tile.example/{z}/{x}/{y}.png'] },
      })

      layer.setStyle({ native: { paint: { 'raster-opacity': 0.5 } } })

      const native = renderer.layers[0]?.style.native
      expect(native?.['source']).toMatchObject({ type: 'raster' })
      expect(native?.['paint']).toEqual({ 'raster-opacity': 0.5 })
    })
  })

  describe('stack order', () => {
    beforeEach(() => {
      store.seed('parcels', [])
      layers.add({ id: 'bottom', type: 'vector', source: 'parcels' })
      layers.add({ id: 'middle', type: 'vector', source: 'parcels' })
      layers.add({ id: 'top', type: 'vector', source: 'parcels' })
    })

    it('lists bottom-to-top and honours beforeId on add', () => {
      layers.add({ id: 'under-middle', type: 'vector', source: 'parcels', beforeId: 'middle' })
      expect(layers.list().map((l) => l.id)).toEqual(['bottom', 'under-middle', 'middle', 'top'])
    })

    it('move(id) with no beforeId sends the layer to the top', () => {
      layers.move('bottom')
      expect(layers.list().map((l) => l.id)).toEqual(['middle', 'top', 'bottom'])
      expect(renderer.layers.at(-1)?.id).toBe('bottom')
    })

    it('move(id, beforeId) re-creates the layer beneath beforeId, keeping its source alive', () => {
      layers.move('top', 'bottom')

      expect(layers.list().map((l) => l.id)).toEqual(['top', 'bottom', 'middle'])
      expect(renderer.layers.find((l) => l.id === 'top')?.beforeId).toBe('bottom')
      // The source must not be torn down and re-uploaded just to restack a layer.
      expect(renderer.removeSourceCalls).toEqual([])
      expect(renderer.addSourceCalls).toEqual(['parcels'])
    })

    it('carries style and visibility across a move', () => {
      const layer = layers.get('top')
      layer?.setStyle({ line: { color: '#0f0' } })
      layer?.setVisible(false)

      layers.move('top', 'bottom')

      expect(renderer.layers.find((l) => l.id === 'top')?.style).toEqual({
        line: { color: '#0f0' },
      })
      expect(renderer.visible.get('top')).toBe(false)
    })

    it('keeps the caller handle working after a move', () => {
      const handle = layers.add({ id: 'extra', type: 'vector', source: 'parcels' })
      layers.move('extra', 'bottom')

      handle.setVisible(false)
      expect(renderer.visible.get('extra')).toBe(false)

      handle.dispose()
      expect(layers.get('extra')).toBeUndefined()
      expect(renderer.layers.some((l) => l.id === 'extra')).toBe(false)
    })

    it('an unknown beforeId is passed through (it is usually a basemap layer)', () => {
      layers.add({ id: 'over-buildings', type: 'vector', source: 'parcels', beforeId: 'building' })
      expect(layers.list().map((l) => l.id)).toEqual(['bottom', 'middle', 'top', 'over-buildings'])
      expect(renderer.layers.at(-1)?.beforeId).toBe('building')
    })
  })

  describe('registerType', () => {
    it('refuses to shadow an existing type', () => {
      expect(() => layers.registerType({ type: 'vector', create: () => ({}) as never })).toThrow(
        /already registered/,
      )
    })

    it('takes its layers with it when unregistered', () => {
      const created: string[] = []
      const handle = layers.registerType({
        type: 'heatmap',
        create: (spec) => {
          created.push(spec.id)
          return {
            id: spec.id,
            type: 'heatmap',
            setVisible: () => {},
            setStyle: () => {},
            dispose: () => created.splice(created.indexOf(spec.id), 1),
          }
        },
      })

      layers.add({ id: 'heat', type: 'heatmap' })
      expect(created).toEqual(['heat'])

      handle.dispose()

      expect(created).toEqual([])
      expect(layers.get('heat')).toBeUndefined()
      expect(() => layers.add({ id: 'heat2', type: 'heatmap' })).toThrow(/unknown layer type/)
    })
  })

  describe('connectStore', () => {
    it('coalesces every change in a tick into ONE setData per collection', async () => {
      store.seed('parcels', [])
      layers.add({ id: 'fill', type: 'vector', source: 'parcels' })
      const wire = layers.connectStore()
      renderer.setDataCalls.length = 0

      // A transaction moving 500 parcels. Pushed straight through this would be 500
      // full re-uploads of the collection; it must be one.
      for (let i = 0; i < 500; i++) store.touch('parcels', feature(`p${i}`, 'parcels'))

      expect(renderer.setDataCallsFor('parcels')).toBe(0) // nothing yet: still this tick
      await tick()

      expect(renderer.setDataCallsFor('parcels')).toBe(1)
      expect(renderer.setDataCalls[0]?.features).toHaveLength(500)

      wire.dispose()
    })

    it('flushes each dirty collection exactly once', async () => {
      store.seed('parcels', [])
      store.seed('roads', [])
      layers.add({ id: 'p', type: 'vector', source: 'parcels' })
      layers.add({ id: 'r', type: 'vector', source: 'roads' })
      const wire = layers.connectStore()
      renderer.setDataCalls.length = 0

      store.touch('parcels', feature('a', 'parcels'))
      store.touch('roads', feature('b', 'roads'))
      store.touch('parcels', feature('c', 'parcels'))
      await tick()

      expect(renderer.setDataCallsFor('parcels')).toBe(1)
      expect(renderer.setDataCallsFor('roads')).toBe(1)

      // A change in a *later* tick is a separate flush, not a lost one.
      store.touch('roads', feature('d', 'roads'))
      await tick()
      expect(renderer.setDataCallsFor('roads')).toBe(2)

      wire.dispose()
    })

    it('pushes existing collections once at connect time', () => {
      store.seed('parcels', [feature('a', 'parcels')])
      layers.add({ id: 'fill', type: 'vector', source: 'parcels' })

      const wire = layers.connectStore()

      expect(renderer.setDataCallsFor('parcels')).toBe(1)
      wire.dispose()
    })

    it('wires the renderer feature resolver to store.find', () => {
      store.seed('parcels', [feature('a', 'parcels')])
      const wire = layers.connectStore()

      expect(renderer.resolver?.('a')?.id).toBe('a')
      expect(renderer.resolver?.('missing')).toBeUndefined()

      wire.dispose()
    })

    it('tolerates a renderer with no feature resolver', () => {
      const plain = new StubRenderer({ featureResolver: false })
      const bare = new FlexiLayerManager(plain, store.asStore(), events)
      expect(() => bare.connectStore().dispose()).not.toThrow()
    })

    it('stops pushing once disposed, even for a flush already queued', async () => {
      store.seed('parcels', [])
      layers.add({ id: 'fill', type: 'vector', source: 'parcels' })
      const wire = layers.connectStore()
      renderer.setDataCalls.length = 0

      store.touch('parcels', feature('a', 'parcels'))
      wire.dispose() // same tick — the flush is already scheduled

      await tick()
      expect(renderer.setDataCalls).toEqual([])
    })

    it('reports a throwing renderer as map:error rather than an unhandled rejection', async () => {
      store.seed('parcels', [])
      layers.add({ id: 'fill', type: 'vector', source: 'parcels' })
      const wire = layers.connectStore()

      const errors: string[] = []
      events.on('map:error', (e) => errors.push(e.payload.source))
      renderer.setData = () => {
        throw new Error('context lost')
      }

      store.touch('parcels', feature('a', 'parcels'))
      await tick()

      expect(errors).toEqual(['layers:setData:parcels'])
      wire.dispose()
    })
  })
})
