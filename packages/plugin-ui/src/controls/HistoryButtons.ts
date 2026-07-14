import { button, el } from '../dom.js'
import { optionalApi, watchPlugin } from '../optional.js'
import type { Control, ControlContext } from '../types.js'

/**
 * The bit of the history plugin's API this control uses.
 *
 * Declared structurally rather than imported — see `optional.ts` for why an
 * optional dependency you have to import is not optional. Every field is guarded
 * at runtime, so a history plugin with a different shape degrades to disabled
 * buttons rather than to a crash.
 */
interface HistoryLike {
  undo?: () => unknown
  redo?: () => unknown
  readonly canUndo?: unknown
  readonly canRedo?: unknown
}

/**
 * Undo and redo.
 *
 * **Optional dependency on the history plugin.** The core's command bus
 * deliberately holds no undo stack — history is a plugin, so a read-only viewer
 * does not pay for one. With no history plugin installed there is nothing to undo,
 * and this control hides itself rather than showing two buttons that do nothing.
 * Install a history plugin at runtime and the buttons appear; remove it and they
 * go away again.
 */
export function historyButtonsControl(): Control {
  return {
    id: 'history',

    render(ctx: ControlContext): HTMLElement {
      const element = el('div', {
        class: 'fx-ui-control fx-ui-toolbar fx-ui-history',
        attrs: { role: 'group', 'aria-label': ctx.i18n.t('ui.undo') },
      })
      element.hidden = true

      const undo = button('fx-ui-button', ctx.i18n.t('ui.undo'))
      undo.appendChild(
        el('span', { class: 'fx-ui-button-icon', text: '↶', attrs: { 'aria-hidden': 'true' } }),
      )
      const redo = button('fx-ui-button', ctx.i18n.t('ui.redo'))
      redo.appendChild(
        el('span', { class: 'fx-ui-button-icon', text: '↷', attrs: { 'aria-hidden': 'true' } }),
      )
      element.append(undo, redo)

      // Resolved on every sync, never cached: the history plugin may not be
      // installed yet when this control is built (see optional.ts), and may be
      // removed while it is on screen.
      const history = (): HistoryLike | undefined => optionalApi<HistoryLike>(ctx, 'history')

      const sync = (payload?: unknown): void => {
        const api = history()
        element.hidden = api === undefined
        if (!api) return
        undo.disabled = !can(api, 'canUndo', payload)
        redo.disabled = !can(api, 'canRedo', payload)
      }

      const relabel = (): void => {
        for (const [node, key] of [
          [undo, 'ui.undo'],
          [redo, 'ui.redo'],
        ] as const) {
          const label = ctx.i18n.t(key)
          node.setAttribute('aria-label', label)
          node.title = label
        }
        element.setAttribute('aria-label', ctx.i18n.t('ui.undo'))
      }

      undo.addEventListener('click', () => history()?.undo?.())
      redo.addEventListener('click', () => history()?.redo?.())

      relabel()

      ctx.disposables.add(watchPlugin(ctx, 'history', () => sync()))

      // `history:*` is the history plugin's own signal (ours emits `history:changed`),
      // read structurally. The `command:*` events are the core's, and they cover a
      // history plugin that emits nothing at all: the stack can only change when a
      // command does.
      ctx.disposables.add(ctx.events.onAny('history:*', (event) => sync(event.payload)))
      ctx.disposables.add(ctx.events.on('command:executed', () => sync()))
      ctx.disposables.add(ctx.events.on('command:undone', () => sync()))
      ctx.disposables.add(ctx.events.on('command:redone', () => sync()))
      ctx.disposables.add(ctx.i18n.onChange(relabel))

      return element
    },
  }
}

/**
 * Read a capability flag from the API, falling back to the event payload.
 *
 * The API is the source of truth when it exposes the flag; the payload covers a
 * history plugin that reports its state only in the event. When neither answers,
 * assume the action is available — a disabled Undo that should be enabled strands
 * the user with no way back, which is the worse of the two failures.
 */
function can(history: HistoryLike, key: 'canUndo' | 'canRedo', payload: unknown): boolean {
  const fromApi = history[key]
  if (typeof fromApi === 'boolean') return fromApi

  if (typeof payload === 'object' && payload !== null) {
    const value = (payload as Record<string, unknown>)[key]
    if (typeof value === 'boolean') return value
  }
  return true
}
