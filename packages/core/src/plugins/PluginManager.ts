import type { Disposable } from '../types/common.js'
import { DisposableStore } from '../types/common.js'
import type {
  BlaeuPlugin,
  BlaeuPluginRegistry,
  PluginContext,
  PluginInfo,
  PluginManager,
} from '../types/plugin.js'
import type { BlaeuEventBus } from '../events/EventBus.js'
import { satisfies } from '../utils/semver.js'

interface Installed {
  readonly plugin: BlaeuPlugin<unknown, unknown>
  readonly ctx: PluginContext<unknown>
  readonly api: unknown
  enabled: boolean
}

/** Everything the manager needs to build a `PluginContext`, minus the per-plugin bits. */
export type ContextFactory = (
  plugin: BlaeuPlugin<unknown, unknown>,
  options: unknown,
  disposables: DisposableStore,
) => PluginContext<unknown>

/**
 * Installs plugins, resolves their dependencies, and runs their lifecycle.
 *
 * The interesting part is **deferred installation**. Plugins arrive in whatever
 * order a preset happens to list them, and a preset composed from two other
 * presets has an order nobody chose deliberately. So `use()` does not fail when a
 * dependency is missing — it *parks* the plugin and installs it the moment its
 * dependencies arrive.
 *
 * The alternative (topologically sorting a batch up front) works for a static
 * list and falls apart the first time someone installs a plugin at runtime, which
 * is exactly what a plugin marketplace does. Parking handles both with one
 * mechanism.
 */
export class BlaeuPluginManager implements PluginManager {
  #installed = new Map<string, Installed>()
  /** Capability token → plugin ids providing it. */
  #capabilities = new Map<string, Set<string>>()
  /** Plugins waiting on a dependency that hasn't arrived yet. */
  #pending: {
    plugin: BlaeuPlugin<unknown, unknown>
    options: unknown
    resolve: (api: unknown) => void
    reject: (e: Error) => void
  }[] = []
  #installHandlers: ((info: PluginInfo) => void)[] = []
  /**
   * Ids whose `use()` has been called but whose install has not finished — either
   * still running `setup`, or parked on a dependency.
   *
   * This exists to make an *optional* dependency resolve by declaration rather than
   * by timing. The map installs plugins concurrently (`Promise.all`), and `use()`
   * runs synchronously up to its first `await` — so by the time any plugin's `setup`
   * resolves, every plugin in the batch has already been announced here. That is what
   * lets us tell the two cases apart:
   *
   *   - the optional dep is *coming* (announced, still installing) → park, and hand the
   *     plugin a real `tryPlugin(id)` when it lands;
   *   - the optional dep is *never coming* (never announced) → install now, and let
   *     `tryPlugin(id)` return `undefined`, which is the degradation the author asked for.
   *
   * Without it, `ctx.tryPlugin('snap')` returned the API or `undefined` depending on
   * whether some *unrelated* hard dependency happened to park the plugin long enough
   * for snap to finish — a race the plugin author cannot see, cannot control, and that
   * fails silently.
   */
  #announced = new Set<string>()

  constructor(
    private readonly makeContext: ContextFactory,
    private readonly events: BlaeuEventBus,
  ) {}

  async use<TApi, TOptions>(
    plugin: BlaeuPlugin<TApi, TOptions>,
    options?: TOptions,
  ): Promise<TApi> {
    // Guard on both the completed set *and* the in-flight set. Checking only
    // `#installed` is a race: it is populated after `#install` finishes, but the map
    // installs plugins concurrently (`Promise.all`), and `use()` runs synchronously up
    // to its first `await`. Two `use()` calls for the same id — a preset that lists it
    // twice, most often from composing two presets that both include it — would both
    // pass an `#installed`-only check and each run `setup`, registering every listener
    // and layer twice. `#announced` is added synchronously below, so the second call
    // sees the first and rejects instead.
    if (this.#installed.has(plugin.id) || this.#announced.has(plugin.id)) {
      throw new Error(
        `[blaeu] plugin "${plugin.id}" is already installed (or still installing). ` +
          `Two instances would each register their listeners and layers, and you would see every action happen twice. ` +
          `If a composed preset lists "${plugin.id}" twice, include it once.`,
      )
    }

    // Synchronously, before the first `await`: see the docstring on `#announced`.
    this.#announced.add(plugin.id)

    // Anything from here to a successful install that throws — a dependency version
    // mismatch (`#missingDependencies`), a `makeContext` that fails, a parked install
    // that later rejects — must take the id back out of `#announced`. Otherwise the
    // duplicate guard above would reject every future retry of a plugin that is neither
    // installed nor installing, turning a recoverable config error into a permanent
    // brick. Idempotent with `#install`'s own cleanup on the paths where both run.
    try {
      const missing = this.#missingDependencies(plugin)
      if (missing.length > 0 || this.#awaitedOptional(plugin).length > 0) {
        // Park it. It installs as soon as the dependencies show up. `await` so a later
        // rejection (a never-arriving dep, a failed install) reaches the cleanup below.
        return await new Promise<TApi>((resolve, reject) => {
          this.#pending.push({
            plugin: plugin as BlaeuPlugin<unknown, unknown>,
            options,
            resolve: resolve as (api: unknown) => void,
            reject,
          })
        })
      }

      return (await this.#install(plugin as BlaeuPlugin<unknown, unknown>, options)) as TApi
    } catch (err) {
      this.#announced.delete(plugin.id)
      throw err
    }
  }

  /** Dependencies that are neither installed nor optional. Version mismatches throw here. */
  #missingDependencies(plugin: BlaeuPlugin<unknown, unknown>): string[] {
    const missing: string[] = []
    for (const dep of plugin.dependencies ?? []) {
      const present = this.has(dep.id)
      if (!present) {
        if (!dep.optional) missing.push(dep.id)
        continue
      }
      if (dep.range) {
        const installedPlugin = this.#installed.get(dep.id)?.plugin
        const version = installedPlugin?.version
        if (!version) {
          throw new Error(
            `[blaeu] "${plugin.id}" requires "${dep.id}@${dep.range}", but "${dep.id}" declares no version.`,
          )
        }
        if (!satisfies(version, dep.range)) {
          throw new Error(
            `[blaeu] "${plugin.id}" requires "${dep.id}@${dep.range}", but "${dep.id}@${version}" is installed.`,
          )
        }
      }
    }
    return missing
  }

  /**
   * Optional dependencies that are *on their way* — announced in this batch, not yet
   * installed. Parking on these is what makes `tryPlugin(id)` deterministic.
   *
   * An optional dependency that was never announced is not listed: it is genuinely
   * absent, and the plugin should install now and degrade, which is the entire point
   * of declaring it optional.
   */
  #awaitedOptional(plugin: BlaeuPlugin<unknown, unknown>): string[] {
    const awaited: string[] = []
    for (const dep of plugin.dependencies ?? []) {
      if (!dep.optional) continue
      if (this.has(dep.id)) continue
      if (this.#announced.has(dep.id)) awaited.push(dep.id)
    }
    return awaited
  }

  /**
   * Nothing is actively installing — every announced id is either installed or parked.
   *
   * When this is true, an awaited optional dependency is never going to arrive on its
   * own (two plugins optionally depending on each other would otherwise park forever),
   * so the waiters are released to degrade rather than deadlock.
   */
  #quiescent(): boolean {
    for (const id of this.#announced) {
      if (this.#installed.has(id)) continue
      if (this.#pending.some((p) => p.plugin.id === id)) continue
      return false // still running its setup
    }
    return true
  }

  async #install(plugin: BlaeuPlugin<unknown, unknown>, options: unknown): Promise<unknown> {
    const disposables = new DisposableStore()
    const ctx = this.makeContext(plugin, options, disposables)

    let api: unknown
    try {
      api = await plugin.setup(ctx)
    } catch (err) {
      // A plugin that fails setup must not leave half its registrations behind —
      // a stray layer or listener from a plugin that "isn't installed" is a
      // genuinely baffling thing to debug.
      disposables.dispose()
      // It is not coming. Anything parked on it as an optional dep must stop waiting.
      this.#announced.delete(plugin.id)
      throw new Error(
        `[blaeu] plugin "${plugin.id}" failed during setup: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }

    const installed: Installed = { plugin, ctx, api, enabled: false }
    this.#installed.set(plugin.id, installed)
    this.#announced.delete(plugin.id)

    for (const cap of plugin.provides ?? []) {
      let set = this.#capabilities.get(cap)
      if (!set) {
        set = new Set()
        this.#capabilities.set(cap, set)
      }
      set.add(plugin.id)
    }

    this.events.emit('plugin:registered', { id: plugin.id })
    this.enable(plugin.id)

    const info = this.#info(installed)
    for (const h of [...this.#installHandlers]) h(info)

    // Something new arrived — anything parked on it may now be installable.
    await this.#drainPending()

    return api
  }

  async #drainPending(): Promise<void> {
    let progressed = true
    while (progressed) {
      progressed = false

      // Once nothing is actively installing, an awaited optional dep is never arriving.
      // Release its waiters to degrade rather than park them forever.
      const relaxOptional = this.#quiescent()

      for (let i = 0; i < this.#pending.length; i++) {
        const entry = this.#pending[i]!

        // `#missingDependencies` throws when a *ranged hard* dependency has now arrived
        // at an incompatible version. That must reject this one parked plugin — not
        // escape the drain, which would leave every other parked plugin hung (its
        // `use()` never settles), reject the successful install that triggered the drain,
        // and skip `settle()`'s own failure report. Handled here like the install failure
        // below: reject the entry, stop tracking it, and carry on.
        try {
          if (this.#missingDependencies(entry.plugin).length > 0) continue
          if (!relaxOptional && this.#awaitedOptional(entry.plugin).length > 0) continue
        } catch (err) {
          this.#pending.splice(i, 1)
          i--
          progressed = true
          this.#announced.delete(entry.plugin.id)
          entry.reject(err instanceof Error ? err : new Error(String(err)))
          continue
        }

        this.#pending.splice(i, 1)
        i--
        progressed = true
        try {
          const api = await this.#install(entry.plugin, entry.options)
          entry.resolve(api)
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
    }
  }

  /**
   * Called once the map has installed everything a preset asked for. Anything
   * still parked has a dependency that is never coming, and we fail loudly rather
   * than leaving a plugin mysteriously inert.
   */
  async settle(): Promise<void> {
    await this.#drainPending()
    if (this.#pending.length === 0) return

    const report = this.#pending
      .map((p) => `  - "${p.plugin.id}" needs: ${this.#missingDependencies(p.plugin).join(', ')}`)
      .join('\n')
    const error = new Error(
      `[blaeu] ${this.#pending.length} plugin(s) could not be installed — missing dependencies:\n${report}\n` +
        `Install the missing plugins, or mark the dependency { optional: true } if the plugin can work without it.`,
    )
    for (const p of this.#pending) {
      this.#announced.delete(p.plugin.id)
      p.reject(error)
    }
    this.#pending = []
    throw error
  }

  get<K extends keyof BlaeuPluginRegistry & string>(id: K): BlaeuPluginRegistry[K] {
    const found = this.#installed.get(id)
    if (!found) {
      throw new Error(
        `[blaeu] plugin "${id}" is not installed. ` +
          `Installed: [${[...this.#installed.keys()].join(', ')}]. ` +
          `If this dependency is optional, use tryPlugin("${id}") instead.`,
      )
    }
    return found.api as BlaeuPluginRegistry[K]
  }

  tryGet<K extends keyof BlaeuPluginRegistry & string>(id: K): BlaeuPluginRegistry[K] | undefined {
    return this.#installed.get(id)?.api as BlaeuPluginRegistry[K] | undefined
  }

  /** True if a plugin with this id, **or any plugin providing this capability**, is installed. */
  has(idOrCapability: string): boolean {
    if (this.#installed.has(idOrCapability)) return true
    const providers = this.#capabilities.get(idOrCapability)
    return providers !== undefined && providers.size > 0
  }

  enable(id: string): void {
    const found = this.#installed.get(id)
    if (!found || found.enabled) return
    found.enabled = true
    found.plugin.enable?.(found.ctx)
    this.events.emit('plugin:enabled', { id })
  }

  disable(id: string): void {
    const found = this.#installed.get(id)
    if (!found || !found.enabled) return
    found.enabled = false
    found.plugin.disable?.(found.ctx)
    this.events.emit('plugin:disabled', { id })
  }

  async remove(id: string): Promise<void> {
    const found = this.#installed.get(id)
    if (!found) return

    // Removing a plugin that others depend on would leave them holding a stale
    // API object and failing in ways that point at the wrong plugin. Refuse, and
    // name the dependents.
    const dependents = [...this.#installed.values()]
      .filter((i) => i.plugin.dependencies?.some((d) => !d.optional && d.id === id))
      .map((i) => i.plugin.id)
    if (dependents.length > 0) {
      throw new Error(
        `[blaeu] cannot remove "${id}" — required by: ${dependents.join(', ')}. Remove those first.`,
      )
    }

    // The teardown itself runs in a `finally`, exactly as `destroyAll()` does. A
    // plugin whose `disable()` or `destroy()` throws — one whose cleanup hook talks
    // to a server that is down, say — would otherwise strand every listener,
    // middleware and layer it ever registered, *and* stay in `#installed`, where it
    // could never be removed or re-installed again. The error still propagates, so
    // the caller learns that the hook failed; what it must not do is take the
    // registrations down with it.
    try {
      this.disable(id)
      await found.plugin.destroy?.(found.ctx)
    } finally {
      found.ctx.disposables.dispose()

      this.#installed.delete(id)
      for (const cap of found.plugin.provides ?? []) {
        this.#capabilities.get(cap)?.delete(id)
      }
      this.events.emit('plugin:removed', { id })
    }
  }

  list(): readonly PluginInfo[] {
    return [...this.#installed.values()].map((i) => this.#info(i))
  }

  onDidInstall(handler: (info: PluginInfo) => void): Disposable {
    this.#installHandlers.push(handler)
    return {
      dispose: () => {
        const i = this.#installHandlers.indexOf(handler)
        if (i >= 0) this.#installHandlers.splice(i, 1)
      },
    }
  }

  #info(i: Installed): PluginInfo {
    return {
      id: i.plugin.id,
      version: i.plugin.version,
      enabled: i.enabled,
      dependencies: i.plugin.dependencies ?? [],
      provides: i.plugin.provides ?? [],
    }
  }

  /** @internal Teardown, in reverse install order so dependents go before dependencies. */
  async destroyAll(): Promise<void> {
    for (const id of [...this.#installed.keys()].reverse()) {
      const found = this.#installed.get(id)
      if (!found) continue
      try {
        this.disable(id)
        await found.plugin.destroy?.(found.ctx)
      } catch (err) {
        console.error(`[blaeu] plugin "${id}" threw during destroy:`, err)
      } finally {
        found.ctx.disposables.dispose()
      }
    }
    this.#installed.clear()
    this.#capabilities.clear()
    this.#pending = []
    this.#announced.clear()
  }
}
