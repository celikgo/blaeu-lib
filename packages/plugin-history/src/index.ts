/**
 * `@blaeu/plugin-history` — undo/redo for every plugin, including the ones that
 * do not exist yet.
 *
 * This plugin is the proof that the command-bus design works. It knows nothing
 * about drawing, editing, parcels or vertices: it subscribes to
 * `commands.onDidExecute`, keeps two stacks of `Command`s, and calls `undo()` on
 * them. A plugin written by a stranger in three years gets Ctrl+Z for free by
 * dispatching a `Command` — no registration here, no import there, no coupling in
 * either direction.
 */

import type { BlaeuPlugin, PluginContext } from '@blaeu/core'
import { HistoryStack, type HistoryApi } from './HistoryStack.js'
import { bindKeyboard, type KeyboardTarget } from './keyboard.js'
import { resolveHistoryOptions, type HistoryOptions } from './options.js'

export type { HistoryApi } from './HistoryStack.js'
export type { HistoryOptions } from './options.js'
export { DEFAULT_LIMIT, DEFAULT_COALESCE_WINDOW_MS } from './options.js'

/**
 * The typed seam. `map.plugin('history')` now resolves to {@link HistoryApi} with
 * no cast, and `map.events.on('history:changed', …)` type-checks its payload.
 */
declare module '@blaeu/core' {
  interface BlaeuPluginRegistry {
    history: HistoryApi
  }

  interface BlaeuEventMap {
    'history:changed': {
      readonly canUndo: boolean
      readonly canRedo: boolean
      readonly depth: number
    }
  }
}

export function historyPlugin(
  options: HistoryOptions = {},
): BlaeuPlugin<HistoryApi, HistoryOptions> {
  // Per-map state, keyed by context (see plugin-select). One plugin object installed on two maps
  // must not let the second map's `setup` clobber the first's stack — otherwise toggling history
  // on one map would start or stop recording on the other, silently dropping its undo entries.
  const stacks = new WeakMap<object, HistoryStack>()

  return {
    id: 'history',
    version: '1.0.0',
    // No dependencies, and it must stay that way. The moment history knows the name
    // of another plugin, it has stopped being a general undo system.

    setup(ctx): HistoryApi {
      // The object form of a plugin spec (`plugins: [historyPlugin({ limit: 20 })]`)
      // carries its options in the closure; the tuple form
      // (`[historyPlugin, { limit: 20 }]`) delivers them through `ctx.options`.
      // Merge, so a preset can be re-tuned either way.
      const resolved = resolveHistoryOptions({ ...options, ...(ctx.options ?? {}) })

      // `ctx.commands` is the `CommandBus` *interface*, and the replay hook
      // `_apply` is declared only on the concrete `BlaeuCommandBus`. Reaching it
      // through `ctx.map` is the sanctioned escape hatch and needs no cast.
      const history = new HistoryStack(ctx.map.commands, ctx.events, resolved, ctx.log)
      stacks.set(ctx, history)

      ctx.disposables.add(
        // The third argument is the one that matters: it tells us whether this command was
        // submitted while an undo/redo was replaying, which an async echo could not
        // otherwise reveal by the time it lands. See HistoryStack.record.
        ctx.commands.onDidExecute((command, _transaction, origin) =>
          history.record(command, undefined, origin),
        ),
      )
      ctx.disposables.addFn(() => history.dispose())

      if (resolved.keyboard) {
        const target = resolveKeyboardTarget(ctx, resolved.container)
        if (target === undefined) {
          ctx.log.warn(
            'keyboard shortcuts are enabled but the map container could not be found on the renderer. ' +
              'Pass `container` in the history options to bind Ctrl/Cmd+Z yourself.',
          )
        } else {
          ctx.disposables.add(bindKeyboard(target, history))
        }
      }

      return history
    },

    // Dormant, not amnesiac (see the lifecycle contract on BlaeuPlugin): a user who
    // toggles history off and on again has not asked us to forget what they did.
    enable(ctx) {
      stacks.get(ctx)?.setRecording(true)
    },

    disable(ctx) {
      stacks.get(ctx)?.setRecording(false)
    },
  }
}

/**
 * Where the keyboard shortcuts get bound.
 *
 * `PluginContext` does not expose the map container — a genuine gap in the core —
 * so we recover it from the renderer: MapLibre answers `getContainer()`, the test
 * `FakeRenderer` exposes `container`. Anything else falls back to the explicit
 * option rather than to `window`, because a window-level binding makes two maps on
 * one page fight over Ctrl+Z, and silently losing an edit on the map you were not
 * looking at is worse than having no shortcut at all.
 */
function resolveKeyboardTarget(
  ctx: PluginContext<HistoryOptions>,
  explicit: HTMLElement | undefined,
): KeyboardTarget | undefined {
  if (explicit !== undefined) return explicit

  let native: unknown
  try {
    native = ctx.renderer.getNative()
  } catch {
    // MapLibre's `getNative()` throws before the map has mounted. A plugin that
    // cannot find a keyboard target still works — every other entry point does.
    return undefined
  }

  if (typeof native !== 'object' || native === null) return undefined
  const source = native as { getContainer?: () => unknown; container?: unknown }
  const element =
    typeof source.getContainer === 'function' ? source.getContainer() : source.container

  return isKeyboardTarget(element) ? element : undefined
}

function isKeyboardTarget(value: unknown): value is KeyboardTarget {
  if (typeof value !== 'object' || value === null) return false
  const target = value as Partial<KeyboardTarget>
  return (
    typeof target.addEventListener === 'function' &&
    typeof target.removeEventListener === 'function'
  )
}
