import { DisposableStore, type Disposable, type Logger } from './types/common.js'
import type { BlaeuMapOptions, ResolvedConfig } from './types/config.js'
import type { BlaeuPlugin, BlaeuPluginRegistry, PluginContext } from './types/plugin.js'
import type { Preset } from './types/preset.js'
import type { Theme } from './types/theme.js'
import type { Renderer, RendererPointerEvent } from './types/renderer.js'
import type { InteractionContext } from './types/pipeline.js'
import type { Tool } from './types/extensions.js'

import { BlaeuEventBus } from './events/EventBus.js'
import { SyncInteractionPipeline, AsyncCommitPipeline } from './pipeline/Pipeline.js'
import { BlaeuCommandBus } from './commands/CommandBus.js'
import { BlaeuPluginManager } from './plugins/PluginManager.js'
import { BlaeuFeatureStore } from './store/FeatureStore.js'
import { BlaeuToolManager } from './tools/ToolManager.js'
import { BlaeuLayerManager } from './layers/LayerManager.js'
import { BlaeuCrsService } from './crs/CrsService.js'
import { BlaeuThemeManager } from './theme/ThemeManager.js'
import { BlaeuI18n } from './i18n/I18n.js'
import { BlaeuValidationRegistry } from './validation/ValidationRegistry.js'
import { MapLibreRenderer, blankStyle } from './renderers/MapLibreRenderer.js'
import { resolveConfig } from './config.js'
import { normalisePluginSpec } from './presets/compose.js'

/**
 * The BlaeuMap kernel.
 *
 * Read the field list below and notice what is **absent**: there is no `draw()`,
 * no `measure()`, no `snapTo()`. The kernel owns exactly five things — an event
 * bus, a plugin registry, two middleware pipelines, a command bus, and a feature
 * store — and everything a user would call a *feature* is a plugin built on top
 * of them.
 *
 * That is the whole design. A mapping library that grows a `map.enableSnapping()`
 * method has, at that moment, decided what snapping means for everyone forever;
 * one that exposes a snap-provider extension point has not. The second is harder
 * to build and is the only one that survives contact with a domain nobody
 * anticipated.
 *
 * @example Minimal
 * ```ts
 * const map = await createBlaeuMap({ container: '#map' })
 * ```
 *
 * @example A cadastre product
 * ```ts
 * const map = await createBlaeuMap({
 *   container: '#map',
 *   preset: cadastrePreset({ crs: 'EPSG:5254', locale: 'tr' }),
 * })
 * map.tools.activate('draw:polygon')
 * map.events.on('draw:complete', (e) => console.log(map.crs.area(e.payload.feature.geometry)))
 * ```
 */
export class BlaeuMap {
  readonly events: BlaeuEventBus
  readonly store: BlaeuFeatureStore
  readonly commands: BlaeuCommandBus
  readonly plugins: BlaeuPluginManager
  readonly interaction: SyncInteractionPipeline
  readonly commit: AsyncCommitPipeline
  readonly tools: BlaeuToolManager
  readonly layers: BlaeuLayerManager
  readonly crs: BlaeuCrsService
  readonly theme: BlaeuThemeManager
  readonly i18n: BlaeuI18n
  readonly validation: BlaeuValidationRegistry
  readonly renderer: Renderer
  readonly config: ResolvedConfig
  readonly log: Logger

  readonly #container: HTMLElement
  readonly #disposables = new DisposableStore()
  #ready: Promise<void>
  #destroyed = false
  /** The basemap last handed to the renderer, so an unchanged theme change is not a redundant restyle. */
  #appliedBasemap: Theme['basemap']

  constructor(options: BlaeuMapOptions) {
    const preset = options.preset
    this.config = resolveConfig(options, preset)
    this.log = this.config.logger
    this.#container = resolveContainer(options.container)

    // ---- kernel, in dependency order ----
    this.events = new BlaeuEventBus()
    this.crs = new BlaeuCrsService(this.config.crs)
    this.i18n = new BlaeuI18n(this.config.locale)
    this.store = new BlaeuFeatureStore(this.crs, this.events, { strict: this.config.strict })
    this.interaction = new SyncInteractionPipeline()
    // Before the command bus, which holds it: `commands.commit()` runs every write
    // through this chain, and that is the only reason a validation rule can veto
    // anything. A bus constructed without it would still compile and still write —
    // it would just quietly write things no rule had ever looked at.
    this.commit = new AsyncCommitPipeline()
    this.commands = new BlaeuCommandBus(this.store, this.events, this.commit, this.crs)
    this.validation = new BlaeuValidationRegistry(this.store, this.crs, this.i18n)
    this.theme = new BlaeuThemeManager(this.#container)

    this.renderer = options.renderer ?? new MapLibreRenderer()
    this.tools = new BlaeuToolManager(this.events)
    this.layers = new BlaeuLayerManager(this.renderer, this.store, this.events, this.theme)

    this.plugins = new BlaeuPluginManager(
      (plugin, pluginOptions, disposables) => this.#makeContext(plugin, pluginOptions, disposables),
      this.events,
    )

    this.#ready = this.#init(options, preset)
  }

  /** Resolves once the renderer has mounted and every plugin's `setup` has completed. */
  whenReady(): Promise<void> {
    return this.#ready
  }

  async #init(options: BlaeuMapOptions, preset: Preset | undefined): Promise<void> {
    await this.renderer.mount(this.#container)

    // Hand the renderer the resolved interaction config. Until here it was dead config —
    // resolved, documented, and read by nothing — so a host that turned `scrollZoom` off (an
    // embedded map on a scrolling page) or a preset that turned `doubleClickZoom` off (a
    // double-click closes a ring, and must not also zoom the map out from under it) had no
    // effect at all. This resolved config is the authoritative, renderer-agnostic source of
    // truth: it is applied after mount and so overrides any construction-time seed a renderer
    // was given (see MapLibreRendererOptions.interaction). Optional on the renderer: a board
    // with no built-in gestures need not toggle.
    this.renderer.setInteraction?.(this.config.interaction)

    // The store must reach the renderer before any plugin can draw. Wiring it here
    // rather than inside the store keeps the store renderer-agnostic — which is
    // what lets the test suite run against a store with no renderer at all.
    this.#disposables.add(this.layers.connectStore())
    this.#disposables.add(this.#wireInteraction())
    this.#disposables.add(this.#wireCamera())

    // The topology index buckets every vertex by its position *in the working plane*, so
    // a runtime `crs.setWorking()` leaves every bucket keyed to a plane that no longer
    // exists — and every shared corner reads as unshared until the index is rebuilt.
    // Wire the rebuild here, once, rather than making the store reach for the event bus.
    this.#disposables.add(this.crs.onChange(() => this.store.topology.rebuild()))

    if (preset?.theme) this.theme.set(preset.theme)
    if (options.theme) this.theme.set(options.theme)

    // The theme owns the basemap, and this is the wire that makes that true. Until
    // here `theme.basemap` was dead config — typed, set by presets, read by nothing.
    // Apply it now that the renderer is mounted, and re-apply on every theme change so
    // a day/night switch swaps the ground under the features, not just the chrome.
    this.#disposables.add(
      this.theme.onChange((theme) => {
        void this.#applyBasemap(theme.basemap)
      }),
    )
    await this.#applyBasemap(this.theme.current.basemap)

    for (const [locale, messages] of Object.entries(preset?.i18n ?? {})) {
      this.#disposables.add(this.i18n.register(locale, messages))
    }

    for (const [middleware, opts] of preset?.interactionMiddleware ?? []) {
      this.#disposables.add(this.interaction.use(middleware, opts))
    }
    for (const [middleware, opts] of preset?.commitMiddleware ?? []) {
      this.#disposables.add(this.commit.use(middleware, opts))
    }

    // Validation runs as commit middleware. That indirection is why the store has
    // never heard of validation, and why a preset can add a rule that blocks an
    // edit made by a plugin written years later.
    this.#disposables.add(this.validation.asCommitMiddleware(this.commit, this.events))
    for (const rule of preset?.validation ?? []) {
      this.#disposables.add(this.validation.add(rule))
    }

    // Preset plugins first, then the user's — so `plugins: [...]` alongside a
    // preset extends it, and can depend on it.
    const specs = [...(preset?.plugins ?? []), ...(options.plugins ?? [])]
    await Promise.all(
      specs.map((spec) => {
        const { plugin, options: pluginOptions } = normalisePluginSpec(spec)
        return this.plugins.use(plugin, pluginOptions)
      }),
    )
    // Anything still parked on a missing dependency fails loudly here rather than
    // sitting inert and being blamed on something else three hours later.
    await this.plugins.settle()

    for (const layer of [...(preset?.layers ?? []), ...(options.layers ?? [])]) {
      this.layers.add(layer)
    }

    if (options.camera) this.renderer.setCamera(options.camera)

    this.events.emit('map:ready', { at: Date.now() })
  }

  /**
   * The heart of the interaction model.
   *
   * A raw pointer event from the renderer is normalised, walked through the
   * interaction pipeline — where snapping, grid-lock and constraints rewrite its
   * position — and only *then* handed to the active tool.
   *
   * This ordering is the reason a tool implementation is usually forty lines. The
   * draw tool does not snap; it reads a position that has already been snapped, by
   * middleware it has never heard of, installed by a preset it knows nothing
   * about.
   */
  #wireInteraction(): Disposable {
    return this.renderer.onPointer((event: RendererPointerEvent) => {
      if (this.#destroyed) return

      const ctx = this.#normalise(event)
      this.interaction.run(ctx)
      if (ctx.consumed) return

      const tool = this.tools.activeTool
      if (!tool) return
      dispatchToTool(tool, ctx)
    })
  }

  #normalise(event: RendererPointerEvent): InteractionContext {
    // Captured because `this` inside the object literal's `get xy()` is the
    // context, not the map. The *service* is captured rather than `crs.working`,
    // so a mid-gesture `setWorking()` is reflected on the next read.
    const crs = this.crs
    let consumed = false
    let lngLat = event.lngLat

    const ctx: InteractionContext = {
      kind: event.kind,
      get lngLat() {
        return lngLat
      },
      set lngLat(value) {
        lngLat = value
      },
      // Derived, so it cannot drift out of sync with lngLat when middleware
      // rewrites it. A cached `xy` that a snap middleware forgot to update is a
      // wonderfully subtle way to place a vertex a metre from where the user
      // clicked.
      get xy() {
        return crs.working.forward(lngLat)
      },
      screen: event.screen,
      ...(event.buttons !== undefined ? { buttons: event.buttons } : {}),
      rawLngLat: event.lngLat,
      snap: undefined,
      // Whatever the active tool said it has hold of. Middleware reads this to avoid
      // fighting the gesture — snapping's chief use is not offering a dragged vertex
      // its own position as a target, which would pin it in place forever.
      dragging: this.tools.dragging,
      button: event.button,
      modifiers: event.modifiers,
      hits: () => this.renderer.queryAt(event.screen),
      consume: () => {
        consumed = true
      },
      get consumed() {
        return consumed
      },
      originalEvent: event.originalEvent,
    }
    return ctx
  }

  /**
   * Push a theme's basemap to the renderer, if the renderer supports swapping it.
   *
   * `null`/`undefined` means "this theme has no opinion about the basemap" — leave
   * whatever is there (the app's own tiles, say). A renderer with no `setBasemap`
   * (a fixed-ground game renderer) is a no-op, not an error, which is why we probe
   * for the method rather than requiring it. A failed swap is reported on
   * `map:error` rather than rejecting the theme change and stranding the chrome.
   */
  async #applyBasemap(basemap: Theme['basemap']): Promise<void> {
    const setBasemap = this.renderer.setBasemap
    if (typeof setBasemap !== 'function') return

    const hasBasemap = basemap !== undefined && basemap !== null
    if (hasBasemap) {
      if (basemap === this.#appliedBasemap) return
    } else {
      // The theme clears the basemap. If we had applied one (a dark ground, say),
      // revert to a blank ground so a light theme does not sit on the old dark map;
      // if we never applied one, leave the app's own initial style untouched.
      if (this.#appliedBasemap === undefined) return
    }

    const target = hasBasemap ? basemap : blankStyle()
    const previous = this.#appliedBasemap
    // Optimistic, but rolled back on failure so a transient error stays retryable.
    this.#appliedBasemap = hasBasemap ? basemap : undefined
    try {
      await setBasemap.call(this.renderer, target)
    } catch (err) {
      this.#appliedBasemap = previous
      this.events.emit('map:error', {
        error: err instanceof Error ? err : new Error(String(err)),
        source: 'theme:basemap',
      })
    }
  }

  #wireCamera(): Disposable {
    return this.renderer.onCamera((camera, moving) => {
      if (this.#destroyed) return
      if (moving) {
        this.events.emit('camera:move', {
          center: camera.center,
          zoom: camera.zoom,
          bearing: camera.bearing,
        })
      } else {
        this.events.emit('camera:idle', { center: camera.center, zoom: camera.zoom })
      }
    })
  }

  #makeContext(
    plugin: BlaeuPlugin<unknown, unknown>,
    options: unknown,
    disposables: DisposableStore,
  ): PluginContext<unknown> {
    return {
      options,
      map: this,
      events: this.events,
      store: this.store,
      commands: this.commands,
      renderer: this.renderer,
      tools: this.tools,
      layers: this.layers,
      crs: this.crs,
      theme: this.theme,
      i18n: this.i18n,
      validation: this.validation,
      interaction: this.interaction,
      commit: this.commit,
      config: this.config,
      // Prefix log lines with the plugin id. Sounds trivial; it is the difference
      // between "something added 4000 layers" and "plugin-heatmap added 4000 layers".
      log: prefixed(this.log, plugin.id),
      disposables,
      plugin: (id) => this.plugins.get(id),
      tryPlugin: (id) => this.plugins.tryGet(id),
    }
  }

  /** Install a plugin at runtime. Same path a preset takes. */
  use<TApi, TOptions>(plugin: BlaeuPlugin<TApi, TOptions>, options?: TOptions): Promise<TApi> {
    return this.plugins.use(plugin, options)
  }

  /** Typed handle to a plugin's API. `map.plugin('draw')` → `DrawApi`, no cast. */
  plugin<K extends keyof BlaeuPluginRegistry & string>(id: K): BlaeuPluginRegistry[K] {
    return this.plugins.get(id)
  }

  /** As above, but `undefined` rather than throwing when absent. */
  tryPlugin<K extends keyof BlaeuPluginRegistry & string>(
    id: K,
  ): BlaeuPluginRegistry[K] | undefined {
    return this.plugins.tryGet(id)
  }

  remove(id: string): Promise<void> {
    return this.plugins.remove(id)
  }

  /** Introspection. Backs devtools, and the teardown test in `blaeu-testing`. */
  readonly debug = {
    snapshot: (): Record<string, number> => ({
      listeners: this.events.listenerCount(),
      middleware: this.interaction.size + this.commit.size,
      layers: this.layers.list().length,
      plugins: this.plugins.list().length,
      features: this.store.collections().reduce((n, c) => n + this.store.collection(c).size, 0),
    }),
    plugins: () => this.plugins.list(),
    interactionMiddleware: () => this.interaction.list(),
    commitMiddleware: () => this.commit.list(),
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return
    this.#destroyed = true
    this.events.emit('map:destroy', {})

    await this.plugins.destroyAll()
    this.#disposables.dispose()
    this.renderer.destroy()
    this.theme.dispose()
    this.interaction.clear()
    this.commit.clear()
    this.events.clear()
  }
}

/**
 * Create and initialise a map.
 *
 * Async because the renderer must mount and every plugin's `setup` must finish
 * before the map is usable — and a plugin's setup may legitimately need to fetch
 * a projection definition or warm a spatial index. Returning a half-initialised
 * map from a synchronous constructor and hoping the user awaits the right thing
 * is how you get bug reports that say "sometimes the first click does nothing."
 */
export async function createBlaeuMap(options: BlaeuMapOptions): Promise<BlaeuMap> {
  const map = new BlaeuMap(options)
  await map.whenReady()
  return map
}

function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container !== 'string') return container
  const el = document.querySelector<HTMLElement>(container)
  if (!el) throw new Error(`[blaeu] container "${container}" not found in the document.`)
  return el
}

function dispatchToTool(tool: Tool, ctx: InteractionContext): void {
  switch (ctx.kind) {
    case 'pointerdown':
      tool.onPointerDown?.(ctx)
      break
    case 'pointermove':
      tool.onPointerMove?.(ctx)
      break
    case 'pointerup':
      tool.onPointerUp?.(ctx)
      break
    case 'click':
      tool.onClick?.(ctx)
      break
    case 'dblclick':
      tool.onDblClick?.(ctx)
      break
    case 'keydown':
      tool.onKeyDown?.(ctx)
      break
  }
}

function prefixed(log: Logger, id: string): Logger {
  const tag = `[${id}]`
  return {
    debug: (m, ...a) => log.debug(`${tag} ${m}`, ...a),
    info: (m, ...a) => log.info(`${tag} ${m}`, ...a),
    warn: (m, ...a) => log.warn(`${tag} ${m}`, ...a),
    error: (m, ...a) => log.error(`${tag} ${m}`, ...a),
  }
}
