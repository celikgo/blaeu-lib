import type { Disposable, DisposableStore, Logger } from './common.js'
import type { EventBus } from './events.js'
import type { CommandBus } from './command.js'
import type { FeatureStore } from './store.js'
import type { Renderer } from './renderer.js'
import type { InteractionPipeline, CommitPipeline } from './pipeline.js'
import type { ToolManager, LayerManager } from './extensions.js'
import type { CrsService } from './crs.js'
import type { ThemeManager } from './theme.js'
import type { I18n } from './i18n.js'
import type { ValidationRegistry } from './validation.js'
import type { ResolvedConfig } from './config.js'
import type { FlexiMap } from '../FlexiMap.js'

/**
 * The typed plugin registry.
 *
 * Plugins augment this from their entry point, and `map.plugin('draw')` then
 * returns `DrawApi` — no cast, no generic parameter, no import of an internal
 * type. Autocomplete lists every installed plugin by id.
 *
 * ```ts
 * declare module '@fleximap/core' {
 *   interface FlexiPluginRegistry { draw: DrawApi }
 * }
 * ```
 *
 * The interface ships empty on purpose; that is not an oversight, it's the seam.
 */
export interface FlexiPluginRegistry {}

/** A dependency on another plugin. */
export interface PluginDependency {
  readonly id: string
  /**
   * Semver range checked against the dependency's `version` at registration.
   * Omit to accept any version.
   */
  readonly range?: string
  /**
   * An optional dependency **enhances** the plugin; it must not be required for
   * it to work. If you mark a dependency optional, you owe the degradation test
   * (see the `fleximap-testing` skill) — an "optional" dependency with no test
   * proving the plugin works without it is a required dependency with a bug.
   */
  readonly optional?: boolean
}

/**
 * Everything a plugin is handed at setup. This is the kernel's entire public
 * surface to plugins — if a capability isn't reachable from here, it isn't
 * extensible, and that's a bug in the core rather than a reason to fork.
 */
export interface PluginContext<TOptions = unknown> {
  /** The options this plugin was installed with, already merged with its defaults. */
  readonly options: TOptions

  /** Escape hatch to the whole map. Prefer the narrow handles below. */
  readonly map: FlexiMap

  readonly events: EventBus
  readonly store: FeatureStore
  readonly commands: CommandBus
  readonly renderer: Renderer
  readonly tools: ToolManager
  readonly layers: LayerManager
  readonly crs: CrsService
  readonly theme: ThemeManager
  readonly i18n: I18n
  readonly validation: ValidationRegistry
  readonly config: ResolvedConfig
  readonly log: Logger

  /**
   * Middleware that runs on every pointer event, **before any tool sees it**.
   *
   * This is where snapping lives, and it is the reason the draw plugin has never
   * heard of the snap plugin: snapping rewrites `ctx.lngLat` on the way through,
   * and the draw tool simply reads a position that has already been snapped.
   * Grid locks, ortho constraints, and coordinate quantisation all belong here
   * too — and all of them then apply to *every* tool, including tools written
   * later by someone else.
   *
   * Synchronous by contract (core invariant 4): this runs at pointer frequency.
   */
  readonly interaction: InteractionPipeline

  /**
   * Middleware that runs on every store mutation, and may veto it.
   *
   * Validation, attribute defaults, audit stamps, server-side topology checks.
   * Async, because a real topology check against a parcel registry is a network
   * call.
   */
  readonly commit: CommitPipeline

  /** Disposed automatically on plugin destroy. Put **everything** you register in here. */
  readonly disposables: DisposableStore

  /** Typed handle to another plugin's API. Throws if absent — use for hard dependencies. */
  plugin<K extends keyof FlexiPluginRegistry & string>(id: K): FlexiPluginRegistry[K]

  /**
   * Typed handle to an *optional* dependency. Returns `undefined` if not installed.
   *
   * ```ts
   * ctx.tryPlugin('snap')?.addProvider(parcelCornerProvider)
   * ```
   */
  tryPlugin<K extends keyof FlexiPluginRegistry & string>(id: K): FlexiPluginRegistry[K] | undefined
}

/**
 * A FlexiMap plugin.
 *
 * @typeParam TApi     - the public API returned from `setup`, surfaced by `map.plugin(id)`
 * @typeParam TOptions - the options the plugin accepts
 *
 * Lifecycle: `setup` once → `enable`/`disable` any number of times → `destroy` once.
 *
 * The split between `disable` and `destroy` is deliberate and matters more than
 * it looks: `disable` means "go dormant but **keep your state**" — a user
 * toggling the measurement tool off and on again expects their measurements to
 * still be there. `destroy` means "you are gone, release everything."
 */
export interface FlexiPlugin<TApi = unknown, TOptions = unknown> {
  /** Unique, stable, kebab-case. This is the key in {@link FlexiPluginRegistry}. */
  readonly id: string

  /** Semver. Checked against dependents' declared ranges. */
  readonly version?: string

  readonly dependencies?: readonly PluginDependency[]

  /**
   * Capability tokens this plugin provides, beyond its own id.
   *
   * Lets a plugin declare `dependencies: [{ id: 'snap-engine' }]` and be
   * satisfied by *any* plugin providing that capability — so a user can swap our
   * snapping for their own without every dependent plugin needing to know.
   */
  readonly provides?: readonly string[]

  /**
   * Register everything and return the public API.
   *
   * May be async — a plugin might need to fetch a projection definition or warm a
   * spatial index before it is usable. The map's `ready` promise waits for all of
   * them.
   */
  setup(ctx: PluginContext<TOptions>): TApi | Promise<TApi>

  enable?(ctx: PluginContext<TOptions>): void
  disable?(ctx: PluginContext<TOptions>): void

  /**
   * Exotic cleanup only. `ctx.disposables` is disposed for you immediately after
   * this returns, so anything registered through it needs no code here.
   */
  destroy?(ctx: PluginContext<TOptions>): void | Promise<void>
}

/**
 * A plugin plus its options, as written in a preset.
 *
 * The tuple form `[drawPlugin, { defaultMode: 'polygon' }]` keeps the factory
 * *un-invoked* until the map installs it, which is what lets a preset be merged,
 * inspected and re-tuned before anything is constructed — including having a
 * later preset override an earlier one's options for the same plugin id.
 */
export type PluginSpec =
  | FlexiPlugin<unknown, never>
  | readonly [factory: (options?: never) => FlexiPlugin<unknown, never>, options?: unknown]

/** Introspection. Powers devtools and the `map.debug` surface. */
export interface PluginInfo {
  readonly id: string
  readonly version: string | undefined
  readonly enabled: boolean
  readonly dependencies: readonly PluginDependency[]
  readonly provides: readonly string[]
}

export interface PluginManager {
  /** Install a plugin. Resolves dependencies, then runs `setup`, then `enable`. */
  use<TApi, TOptions>(plugin: FlexiPlugin<TApi, TOptions>, options?: TOptions): Promise<TApi>

  get<K extends keyof FlexiPluginRegistry & string>(id: K): FlexiPluginRegistry[K]
  tryGet<K extends keyof FlexiPluginRegistry & string>(id: K): FlexiPluginRegistry[K] | undefined

  has(idOrCapability: string): boolean
  enable(id: string): void
  disable(id: string): void
  remove(id: string): Promise<void>
  list(): readonly PluginInfo[]

  onDidInstall(handler: (info: PluginInfo) => void): Disposable
}
