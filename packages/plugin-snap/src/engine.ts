import type {
  Bbox,
  Disposable,
  FeatureId,
  InteractionContext,
  LngLat,
  PluginContext,
  ScreenPoint,
  SnapCandidate,
  SnapKind,
  SnapProvider,
  SnapQueryContext,
  SnapResult,
} from '@fleximap/core'
import { BUILTIN_KINDS, DEFAULT_TOLERANCE_PX, MIDDLEWARE_PRIORITY } from './constants.js'
import { FrameCache, type SnapDeps } from './geometry.js'
import { SnapIndicator } from './indicator.js'
import { createBuiltinProvider } from './providers/index.js'
import type { SnapApi, SnapOptions } from './types.js'

/** Options with every hole filled. */
interface ResolvedOptions {
  readonly tolerance: number
  readonly kinds: readonly SnapKind[]
  readonly gridSize: number
  readonly enabled: boolean
}

export function resolveOptions(options: SnapOptions): ResolvedOptions {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_PX
  if (!(tolerance > 0)) {
    throw new Error(
      `[fleximap] snapPlugin({ tolerance: ${String(options.tolerance)} }) — the tolerance is a radius in screen ` +
        `pixels and must be greater than zero. To turn snapping off, pass { enabled: false } or call ` +
        `map.plugin('snap').disable().`,
    )
  }

  const gridSize = options.gridSize ?? 0
  if (options.gridSize !== undefined && !(gridSize > 0)) {
    throw new Error(
      `[fleximap] snapPlugin({ gridSize: ${String(options.gridSize)} }) — the grid spacing is in metres in the ` +
        `working CRS and must be greater than zero. Omit it entirely to install no grid provider.`,
    )
  }

  // Grid is opt-in twice over: it must be asked for *and* be given a spacing. A grid
  // provider with no grid would offer a candidate at every pixel of the map, at the
  // bottom priority, forever — visible only as an indicator that never quite goes away.
  const kinds = options.providers ?? BUILTIN_KINDS.filter((kind) => kind !== 'grid' || gridSize > 0)

  return { tolerance, kinds, gridSize, enabled: options.enabled ?? true }
}

/**
 * The snap engine: **one interaction middleware**, and a registry of providers.
 *
 * This is the whole architecture in one sentence — snapping is not a service that
 * tools call, it is middleware that rewrites `ctx.lngLat` on the way through the
 * pipeline, at priority 100, before any tool has seen the event. That is why the
 * draw plugin does not import this package, why nothing here is exported for other
 * plugins to call on the hot path, and why a tool written by a stranger next year
 * gets snapping for free without a line of code.
 *
 * The engine's own state is entirely ephemeral (the current snap, the exclusion set,
 * the in-progress ring). None of it belongs in the feature store, so none of it is a
 * command: there is nothing here to undo, and inventing an undo entry for "the mouse
 * moved" would be a bug, not a feature.
 */
export class SnapEngine {
  readonly #ctx: PluginContext<SnapOptions>
  readonly #deps: SnapDeps
  readonly #indicator: SnapIndicator
  readonly #providers = new Map<string, SnapProvider>()

  #tolerance: number
  /** `disable()` on the API. The user turned snapping off. */
  #enabled: boolean
  /** `disable()` on the *plugin* lifecycle. The host put the whole plugin to sleep. */
  #dormant = true

  #exclude: ReadonlySet<FeatureId> = new Set()
  #inProgress: readonly LngLat[] = []
  #current: SnapResult | undefined

  /** What `map.plugin('snap')` returns. */
  readonly api: SnapApi

  constructor(ctx: PluginContext<SnapOptions>, options: ResolvedOptions) {
    this.#ctx = ctx
    this.#tolerance = options.tolerance
    this.#enabled = options.enabled

    this.#deps = {
      store: ctx.store,
      crs: ctx.crs,
      i18n: ctx.i18n,
      cache: new FrameCache(),
      gridSize: options.gridSize,
    }

    this.#indicator = new SnapIndicator(ctx.renderer, ctx.theme)

    for (const kind of options.kinds) {
      const provider = createBuiltinProvider(kind, this.#deps)
      if (provider === undefined) {
        // Not an error: a preset may list a kind whose provider is contributed by
        // another plugin (`'parcel-corner'`), and that plugin registers it itself.
        ctx.log.debug(
          `no built-in provider for snap kind "${kind}" — register one with map.plugin('snap').addProvider().`,
        )
        continue
      }
      this.#providers.set(provider.id, provider)
    }

    this.api = this.#makeApi()
  }

  /** Everything the plugin registers with the kernel. All of it lands in `ctx.disposables`. */
  install(): void {
    const { disposables, interaction } = this.#ctx

    disposables.add(this.#indicator.mount())
    disposables.add(
      interaction.use((ctx, next) => this.#middleware(ctx, next), {
        id: 'snap',
        priority: MIDDLEWARE_PRIORITY,
      }),
    )
    // The engine outlives neither the map nor the plugin: whatever the last pointer
    // move left on screen goes with it.
    disposables.addFn(() => this.#publish(undefined))
  }

  /* ===================================================================== */
  /* The middleware                                                        */
  /* ===================================================================== */

  #middleware(ctx: InteractionContext, next: () => void): void {
    // Alt suppresses snapping for exactly this event. It is the universal CAD
    // convention — AutoCAD, Rhino, Illustrator — and users reach for it without
    // thinking when they need to place a point *near* a corner rather than *on* it.
    // Handling it here, once, is what gives every tool the behaviour for free.
    if (!this.#active || ctx.kind === 'keydown' || ctx.modifiers.alt) {
      this.#publish(undefined)
      next()
      return
    }

    // `ctx.dragging` is what the active tool declared it has hold of — its geometry, its
    // handles, its guide box. Those must never be snap targets: offering the dragged
    // vertex its own current position pins it there, and every drag shorter than the
    // tolerance becomes a silent no-op. The engine learns this from the kernel, not from
    // the edit plugin, which it has never heard of.
    const result = this.#query(ctx.rawLngLat, ctx.screen, ctx.dragging)
    this.#publish(result)

    if (result !== undefined) {
      ctx.snap = result
      // The rewrite. Everything downstream — grid lock, ortho constraint, the active
      // tool — now reads a position that is *on* the corner, and none of them had to
      // know that snapping exists.
      ctx.lngLat = result.candidate.point
    }

    next()
  }

  get #active(): boolean {
    return this.#enabled && !this.#dormant && this.#providers.size > 0
  }

  #query(
    point: LngLat,
    screen: ScreenPoint,
    dragging: readonly FeatureId[] = [],
  ): SnapResult | undefined {
    // One reset per event, shared by every provider: five providers all want the same
    // features projected into the same plane, and doing it five times is how a snap
    // engine turns a 120 Hz pointer into a 30 Hz one.
    this.#deps.cache.reset()

    const query: SnapQueryContext = {
      project: (lngLat) => this.#ctx.renderer.project(lngLat),
      unproject: (p) => this.#ctx.renderer.unproject(p),
      bbox: this.#toleranceBbox(screen),
      // The union of what a plugin asked to exclude (`SnapApi.exclude`, used by draw for
      // the ring it is still closing) and what the active tool is dragging.
      exclude: dragging.length === 0 ? this.#exclude : new Set([...this.#exclude, ...dragging]),
      inProgress: this.#inProgress,
    }

    const candidates: SnapCandidate[] = []
    for (const provider of this.#providers.values()) {
      try {
        candidates.push(...provider.query(point, this.#tolerance, query))
      } catch (err) {
        // A third-party provider that throws must not wedge the pointer. Losing its
        // candidates is a degraded map; throwing out of the interaction pipeline is a
        // dead cursor.
        this.#ctx.log.warn(
          `snap provider "${provider.id}" threw and was skipped for this event: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }

    if (candidates.length === 0) return undefined

    candidates.sort(byPriorityThenDistance)
    return { candidate: candidates[0]!, alternatives: candidates }
  }

  /**
   * The tolerance circle, as a 4326 bbox, for hitting the store's R-tree.
   *
   * Built from the four corners of the tolerance *square in screen space* and then
   * un-projected, rather than from a degrees-per-pixel guess. That is what keeps it
   * correct under a rotated camera (where the screen square is a rotated diamond on
   * the ground) and at high latitudes (where a pixel is worth far fewer degrees of
   * longitude than of latitude).
   */
  #toleranceBbox(screen: ScreenPoint): Bbox {
    const t = this.#tolerance
    let west = Infinity
    let south = Infinity
    let east = -Infinity
    let north = -Infinity

    for (const [dx, dy] of CORNERS) {
      const [lng, lat] = this.#ctx.renderer.unproject({
        x: screen.x + dx * t,
        y: screen.y + dy * t,
      })
      if (lng < west) west = lng
      if (lng > east) east = lng
      if (lat < south) south = lat
      if (lat > north) north = lat
    }

    return [west, south, east, north]
  }

  #publish(result: SnapResult | undefined): void {
    if (sameResult(this.#current, result)) return

    this.#current = result
    this.#indicator.render(result)
    this.#ctx.events.emit('snap:changed', { result })
  }

  /* ===================================================================== */
  /* Lifecycle, driven by the plugin                                       */
  /* ===================================================================== */

  /** The host enabled the plugin. Restores whatever `enabled`/`disabled` state the user had chosen. */
  wake(): void {
    this.#dormant = false
  }

  /** The host disabled the plugin: go dormant, but *keep* the user's settings — providers, tolerance, exclusions. */
  sleep(): void {
    this.#dormant = true
    this.#publish(undefined)
  }

  /* ===================================================================== */
  /* The public API                                                        */
  /* ===================================================================== */

  #addProvider(provider: SnapProvider): Disposable {
    if (this.#providers.has(provider.id)) {
      throw new Error(
        `[fleximap] a snap provider with id "${provider.id}" is already registered. ` +
          `Provider ids are the key the engine — and removeProvider() — works with, so they must be unique: ` +
          `namespace yours, e.g. "cadastre:parcel-corner".`,
      )
    }

    this.#providers.set(provider.id, provider)
    return {
      dispose: () => {
        // Identity-checked: a later registration under the same id must not be torn
        // down by an older handle's dispose.
        if (this.#providers.get(provider.id) !== provider) return
        this.#providers.delete(provider.id)
      },
    }
  }

  #setTolerance(px: number): void {
    if (!(px > 0)) {
      throw new Error(
        `[fleximap] setTolerance(${String(px)}) — the snap tolerance is a radius in screen pixels and must be ` +
          `greater than zero. To turn snapping off, call map.plugin('snap').disable().`,
      )
    }
    this.#tolerance = px
  }

  /**
   * Built in the constructor rather than as a field initialiser, because every
   * method here has to close over the *engine's* `this` — inside an object literal,
   * `this` is the literal.
   */
  #makeApi(): SnapApi {
    const current = (): SnapResult | undefined => this.#current

    return {
      addProvider: (provider: SnapProvider): Disposable => this.#addProvider(provider),
      removeProvider: (id: string): void => {
        this.#providers.delete(id)
      },
      providers: (): readonly SnapProvider[] => [...this.#providers.values()],
      setTolerance: (px: number): void => this.#setTolerance(px),

      get current(): SnapResult | undefined {
        return current()
      },

      enable: (): void => {
        this.#enabled = true
      },

      disable: (): void => {
        this.#enabled = false
        this.#publish(undefined)
      },

      exclude: (ids: Iterable<FeatureId>): void => {
        this.#exclude = new Set(ids)
      },

      setInProgress: (points: readonly LngLat[]): void => {
        // Copied, not aliased: a draw plugin holds its ring in a mutable array and
        // pushes to it. Keeping the reference would let the engine see vertices the
        // user has not committed yet — including, during a drag, the one still moving.
        this.#inProgress = [...points]
      },
    }
  }
}

/** The four corners of the tolerance square, in units of the tolerance. */
const CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]

/**
 * Priority first, distance second — and that order is load-bearing.
 *
 * When the pointer is near a corner, the perpendicular foot on the edge *through*
 * that corner is at exactly the same distance, to the last bit. Sorting by distance
 * first would make snapping to a corner a coin flip, which users experience as the
 * software being broken in a way they cannot describe.
 */
function byPriorityThenDistance(a: SnapCandidate, b: SnapCandidate): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  return a.distancePx - b.distancePx
}

function sameResult(a: SnapResult | undefined, b: SnapResult | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false

  const x = a.candidate
  const y = b.candidate
  return (
    x.kind === y.kind &&
    x.point[0] === y.point[0] &&
    x.point[1] === y.point[1] &&
    x.feature === y.feature
  )
}
