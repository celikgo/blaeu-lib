// FeatureId comes from common.js, not feature.js: feature.ts imports it but does
// not re-export it, so `import type { FeatureId } from '../types/feature.js'`
// fails to compile (TS2459).
import {
  DisposableStore,
  type CollectionId,
  type Disposable,
  type FeatureId,
} from '../types/common.js'
import type { EventBus } from '../types/events.js'
import type { BlaeuFeature } from '../types/feature.js'
import type { LayerInstance, LayerManager, LayerSpec, LayerTypeDef } from '../types/extensions.js'
import type { LayerStyle, Renderer } from '../types/renderer.js'
import type { FeatureStore } from '../types/store.js'
import { createVectorLayerType } from './vectorLayerType.js'
import { createRasterLayerType } from './rasterLayerType.js'

/**
 * A renderer that can turn a hit-test result back into a real {@link BlaeuFeature}.
 *
 * Optional on purpose. `Renderer` does not require it, because a renderer for a
 * game map may have no notion of a store-backed feature at all — so we probe for
 * the method rather than demanding it.
 */
interface FeatureResolvingRenderer {
  setFeatureResolver(resolve: (id: FeatureId) => BlaeuFeature | undefined): void
}

function canResolveFeatures(renderer: Renderer): renderer is Renderer & FeatureResolvingRenderer {
  return typeof (renderer as Partial<FeatureResolvingRenderer>).setFeatureResolver === 'function'
}

interface SourceRef {
  readonly disposable: Disposable
  refs: number
}

interface LayerRecord {
  /** The instance the *type* produced. Replaced wholesale by `move()`. */
  inner: LayerInstance
  /** The spec as it currently stands — style/visibility edits are folded back in. */
  spec: LayerSpec
  /** The handle handed to the caller. Survives `move()`. */
  readonly handle: LayerInstance
}

/**
 * Owns the layer stack, the renderer sources behind it, and the one wire that
 * carries store data to the screen.
 */
export class BlaeuLayerManager implements LayerManager {
  readonly #renderer: Renderer
  readonly #store: FeatureStore
  readonly #events: EventBus

  readonly #types = new Map<string, LayerTypeDef>()
  readonly #layers = new Map<string, LayerRecord>()
  /** Layer ids, bottom-to-top. The renderer's stack order, mirrored so `move()` can reason about it. */
  #order: string[] = []

  /**
   * Renderer sources, ref-counted by the layers using them.
   *
   * A fill layer and an outline layer over the same `parcels` collection are two
   * layers and *one* source: uploading the same geometry to the GPU twice is a
   * straightforward waste, and worse, the two copies then update on different
   * ticks and visibly disagree during a drag.
   */
  readonly #sources = new Map<CollectionId, SourceRef>()

  constructor(renderer: Renderer, store: FeatureStore, events: EventBus) {
    this.#renderer = renderer
    this.#store = store
    this.#events = events

    this.registerType(
      createVectorLayerType(renderer, (collection) => this.#acquireSource(collection)),
    )
    this.registerType(createRasterLayerType(renderer))
  }

  /* ===================================================================== */
  /* Types                                                                 */
  /* ===================================================================== */

  registerType<T>(def: LayerTypeDef<T>): Disposable {
    if (this.#types.has(def.type)) {
      throw new Error(
        `[blaeu] layer type "${def.type}" is already registered. ` +
          `Core ships "vector" and "raster"; pick a different, namespaced type name (e.g. "acme:${def.type}") ` +
          `rather than shadowing an existing one — layers already on the map were built by the first definition.`,
      )
    }
    // `create` is a method, so `LayerTypeDef<T>` and `LayerTypeDef` check
    // bivariantly; the cast just states out loud that the manager stores every
    // type behind one erased signature and hands each its own config back at add().
    this.#types.set(def.type, def as LayerTypeDef)

    return {
      dispose: () => {
        if (this.#types.get(def.type) !== (def as LayerTypeDef)) return
        // Layers outlive their type only as zombies: nothing can restyle or
        // re-stack them, because `move()` rebuilds through the type. Take them
        // with it — a plugin removing its layer type is removing its feature.
        for (const [id, record] of [...this.#layers]) {
          if (record.spec.type === def.type) this.remove(id)
        }
        this.#types.delete(def.type)
      },
    }
  }

  /* ===================================================================== */
  /* Layers                                                                */
  /* ===================================================================== */

  add(spec: LayerSpec): LayerInstance {
    if (this.#layers.has(spec.id)) {
      throw new Error(
        `[blaeu] layer "${spec.id}" already exists. ` +
          `Remove it first, or use a distinct id — two layers under one id would leave one of them unreachable and unremovable.`,
      )
    }

    const def = this.#types.get(spec.type)
    if (!def) {
      throw new Error(
        `[blaeu] unknown layer type "${spec.type}" for layer "${spec.id}". ` +
          `Registered types: [${[...this.#types.keys()].join(', ')}]. ` +
          `Layer types are registered by plugins — check the plugin providing "${spec.type}" is installed, ` +
          `or register it with map.layers.registerType({ type: "${spec.type}", create }).`,
      )
    }

    const record = this.#instantiate(def, spec)
    this.#layers.set(spec.id, record)
    this.#insertIntoOrder(spec.id, spec.beforeId)
    return record.handle
  }

  #instantiate(def: LayerTypeDef, spec: LayerSpec): LayerRecord {
    const inner = def.create(spec)

    // Applied centrally rather than in each type: `visible` is part of the shared
    // LayerSpec, and a third-party layer type that forgets to honour it would fail
    // in a way that looks like a bug in the core.
    if (spec.visible === false) inner.setVisible(false)

    const record: LayerRecord = {
      inner,
      spec,
      // The handle is a stable façade over an instance that `move()` may replace.
      // Hand out `record.inner` directly and a caller who moved a layer is holding
      // a disposed object that silently does nothing.
      handle: {
        id: spec.id,
        type: spec.type,
        setVisible: (visible: boolean) => {
          const current = this.#layers.get(spec.id)
          if (!current) return
          current.spec = { ...current.spec, visible }
          current.inner.setVisible(visible)
        },
        setStyle: (style: LayerStyle) => {
          const current = this.#layers.get(spec.id)
          if (!current) return
          current.spec = { ...current.spec, style }
          current.inner.setStyle(style)
        },
        dispose: () => this.remove(spec.id),
      },
    }
    return record
  }

  remove(id: string): void {
    const record = this.#layers.get(id)
    if (!record) return
    // Delete first: the instance's dispose() may re-enter through the handle
    // (a plugin's DisposableStore holding both), and the second pass must be a
    // no-op rather than a double removal in the renderer.
    this.#layers.delete(id)
    this.#order = this.#order.filter((x) => x !== id)
    record.inner.dispose()
  }

  get(id: string): LayerInstance | undefined {
    return this.#layers.get(id)?.handle
  }

  /** Bottom-to-top, i.e. draw order. */
  list(): readonly LayerInstance[] {
    return this.#order.flatMap((id) => {
      const record = this.#layers.get(id)
      return record ? [record.handle] : []
    })
  }

  /**
   * Restack a layer.
   *
   * The `Renderer` contract has no `moveLayer` — deliberately, because a renderer
   * that has one is a renderer whose layer stack is mutable in a second way, and
   * two ways to reorder is one too many to keep consistent. So a move is a
   * remove-and-recreate through the layer's *type*, which works for third-party
   * types (heatmap, deck.gl, fog-of-war) without any of them implementing
   * anything. The current style and visibility ride along in `record.spec`,
   * which is why the manager folds every `setStyle`/`setVisible` back into it.
   */
  move(id: string, beforeId?: string): void {
    const record = this.#layers.get(id)
    if (!record) {
      throw new Error(
        `[blaeu] cannot move layer "${id}": no such layer. Layers: [${this.#order.join(', ')}].`,
      )
    }
    if (beforeId === id) {
      throw new Error(`[blaeu] cannot move layer "${id}" before itself.`)
    }

    const def = this.#types.get(record.spec.type)
    if (!def) {
      throw new Error(
        `[blaeu] cannot move layer "${id}": its type "${record.spec.type}" is no longer registered.`,
      )
    }

    const spec: LayerSpec =
      beforeId === undefined ? stripBeforeId(record.spec) : { ...record.spec, beforeId }

    // Pin the source across the rebuild. Without this, disposing the old instance
    // drops the last reference, the renderer tears the source down, and the new
    // instance re-uploads every feature in the collection — a full GPU round-trip
    // to change one integer in the draw order.
    const pin = this.#pinSource(record.spec)
    try {
      record.inner.dispose()
      this.#order = this.#order.filter((x) => x !== id)

      record.inner = def.create(spec)
      record.spec = spec
      if (spec.visible === false) record.inner.setVisible(false)
      this.#insertIntoOrder(id, beforeId)
    } finally {
      pin?.dispose()
    }
  }

  /**
   * `beforeId` means "draw beneath this layer" (MapLibre's sense). An unknown
   * `beforeId` is *not* an error: it is very often a basemap layer id from the
   * renderer's own style — `map.layers.add({ …, beforeId: 'building' })` is how you
   * put parcels under the building footprints — and those layers are invisible to
   * us. We pass it through and stack the layer on top of what we do know about.
   */
  #insertIntoOrder(id: string, beforeId: string | undefined): void {
    const at = beforeId === undefined ? -1 : this.#order.indexOf(beforeId)
    if (at < 0) this.#order.push(id)
    else this.#order.splice(at, 0, id)
  }

  /* ===================================================================== */
  /* Sources                                                               */
  /* ===================================================================== */

  /** A second claim on the source a layer already holds, if it is one of ours. */
  #pinSource(spec: LayerSpec): Disposable | undefined {
    const collection = spec.source
    if (collection === undefined || !this.#sources.has(collection)) return undefined
    return this.#acquireSource(collection)
  }

  #acquireSource(collection: CollectionId): Disposable {
    let ref = this.#sources.get(collection)
    if (!ref) {
      ref = {
        disposable: this.#renderer.addSource(collection, this.#renderable(collection)),
        refs: 0,
      }
      this.#sources.set(collection, ref)
    }
    ref.refs++

    let released = false
    return {
      dispose: () => {
        if (released) return
        released = true
        ref.refs--
        if (ref.refs > 0) return
        this.#sources.delete(collection)
        ref.disposable.dispose()
      },
    }
  }

  /**
   * Features of a collection that the renderer should see.
   *
   * `meta.hidden` is filtered here rather than in the store, because "hidden" is a
   * presentation fact: the feature is still selectable by a query, still snappable
   * if a plugin wants it to be, still undoable. It simply isn't drawn.
   */
  #renderable(collection: CollectionId): readonly BlaeuFeature[] {
    if (!this.#store.collections().includes(collection)) return []
    return this.#store
      .collection(collection)
      .all()
      .filter((f) => f.meta.hidden !== true)
  }

  /* ===================================================================== */
  /* The store → renderer wire                                             */
  /* ===================================================================== */

  /**
   * Connect the store to the renderer. Called once, by the kernel, at init.
   *
   * **The single biggest rendering-performance decision in the library lives here:
   * store changes are coalesced into one `setData` per collection per microtask.**
   *
   * A command that moves 500 parcels emits 500 store changes — or a transaction of
   * 500 commands does. Pushed straight through, that is 500 full re-serialisations
   * of the collection and 500 GPU uploads, and the map locks up for seconds on a
   * dataset that a batched implementation redraws in one frame. The cost of a
   * `queueMicrotask` is one tick of latency, which is invisible: the microtask
   * drains before the browser paints, so the user never sees a stale frame. It is
   * as close to free as an optimisation gets, and skipping it turns every bulk
   * edit into a hang.
   *
   * Microtask, not `requestAnimationFrame`: rAF would be *better* still for
   * throughput, but it does not run in a headless test and it would drop us a frame
   * behind a synchronous `expect(renderer.data).toEqual(...)`. Coalescing to the
   * microtask keeps the whole test suite honest without a fake clock.
   */
  connectStore(): Disposable {
    const disposables = new DisposableStore()

    // Hit-testing returns whatever the renderer's own tiles carry — in MapLibre,
    // a plain GeoJSON copy of `properties`, with none of our `meta` and no
    // guarantee of identity. Handing the renderer the store's lookup is what lets
    // `ctx.hits()` return the real BlaeuFeature a command can act on.
    if (canResolveFeatures(this.#renderer)) {
      this.#renderer.setFeatureResolver((id) => this.#store.find(id))
    }

    for (const collection of this.#store.collections()) {
      this.#push(collection)
    }

    const dirty = new Set<CollectionId>()
    let scheduled = false
    let stopped = false

    const flush = (): void => {
      scheduled = false
      if (stopped) return
      const collections = [...dirty]
      dirty.clear()
      for (const collection of collections) this.#push(collection)
    }

    disposables.add(
      this.#store.onChange((change) => {
        dirty.add(change.collection)
        if (scheduled) return
        scheduled = true
        queueMicrotask(flush)
      }),
    )

    disposables.addFn(() => {
      // A queued flush after teardown would talk to a destroyed renderer.
      stopped = true
      dirty.clear()
    })

    return disposables
  }

  #push(collection: CollectionId): void {
    try {
      this.#renderer.setData(collection, this.#renderable(collection))
    } catch (err) {
      // We are inside a microtask: an exception here has no caller to catch it and
      // would surface as an unhandled rejection with no map context attached.
      this.#events.emit('map:error', {
        error: err instanceof Error ? err : new Error(String(err)),
        source: `layers:setData:${collection}`,
      })
    }
  }
}

/** `beforeId: undefined` is not the same as absent under exactOptionalPropertyTypes. */
function stripBeforeId(spec: LayerSpec): LayerSpec {
  const { beforeId: _beforeId, ...rest } = spec
  return rest
}
