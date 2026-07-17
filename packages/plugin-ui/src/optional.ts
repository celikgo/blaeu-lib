import type { Disposable } from '@blaeu/core'
import type { ControlContext } from './types.js'

/**
 * Watch whether an optional plugin is present — **now and later**.
 *
 * A one-off `plugins.has('history')` inside `setup()` is a trap, and it took a
 * failing test to see it. The kernel installs a preset's plugins with
 * `Promise.all`, and `PluginManager.use()` does not park a plugin on an *optional*
 * dependency (correctly — that is what optional means). So whether `history` is
 * already installed when the UI's `setup()` runs depends on microtask ordering
 * between two concurrent installs: `plugins: [historyPlugin(), uiPlugin()]` and
 * `plugins: [uiPlugin(), historyPlugin()]` can give different answers, and the
 * first one is not even the intuitive way round.
 *
 * The fix is not to guess earlier but to stop guessing: presence is a *live*
 * property. `plugin:registered` and `plugin:removed` are core events, so this also
 * handles the case the ordering problem obscured — a plugin installed at runtime,
 * long after the UI was built. The undo buttons appear when history arrives and
 * disappear when it leaves, and neither the UI nor the history plugin knows the
 * other exists.
 */
export function watchPlugin(
  ctx: ControlContext,
  id: string,
  handler: (present: boolean) => void,
): Disposable {
  let present = ctx.map.plugins.has(id)
  handler(present)

  const check = (): void => {
    // `has()` takes a plain string and matches *capability tokens* too, so a
    // third-party engine declaring `provides: ['history']` satisfies this without
    // being called "history".
    const next = ctx.map.plugins.has(id)
    if (next === present) return
    present = next
    handler(present)
  }

  const registered = ctx.events.on('plugin:registered', check)
  const removed = ctx.events.on('plugin:removed', check)

  return {
    dispose: () => {
      registered.dispose()
      removed.dispose()
    },
  }
}

/**
 * A handle on an optional plugin's API, read structurally.
 *
 * This goes through `ctx.tryPlugin(id)` — the kernel's sanctioned handle on an
 * optional dependency — and nowhere else. Reaching into `map.plugins` for its
 * `tryGet` would be a plugin reading the manager's surface rather than the one the
 * `PluginContext` hands it, which is exactly the coupling the context exists to
 * prevent.
 *
 * The only cast is on the *signature*: `tryPlugin` is keyed on
 * `keyof BlaeuPluginRegistry`, and that key belongs to the other plugin's module
 * augmentation. Importing that augmentation to make `tryPlugin('history')`
 * type-check would turn an optional dependency into a compile-time one — this
 * package would no longer build without it, and the degradation test would be
 * testing a lie. So the id is widened to `string`, and the result is guarded at
 * runtime by the caller, which declares an interface of what it actually uses.
 */
export function optionalApi<T>(ctx: ControlContext, id: string): T | undefined {
  const tryPlugin = ctx.tryPlugin as (pluginId: string) => unknown
  const api = tryPlugin(id)
  return typeof api === 'object' && api !== null ? (api as T) : undefined
}
