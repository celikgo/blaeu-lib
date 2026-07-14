import { el } from '../dom.js'
import type { Control, ControlContext, SnapSample } from '../types.js'

/**
 * A small tooltip by the cursor, naming what the pointer has snapped to.
 *
 * **Optional dependency on the snap plugin.** With no snap engine installed,
 * `ctx.snap` is never set and no `snap:*` event ever fires, so the indicator stays
 * hidden and this control does nothing. That is the degradation contract: not
 * "crashes politely", but *works, minus the feature*.
 *
 * Two sources, deliberately:
 *
 * - `InteractionContext.snap`, via the pointer feed. This is the core's own
 *   contract — "set by the snapping middleware, read by UI middleware that draws
 *   the indicator" — and it works with **any** snap engine that honours it,
 *   including one written to replace ours.
 * - A `snap:*` event, read structurally. Our snap plugin emits `snap:changed`, and
 *   an engine that only publishes an event (because it snaps outside the pointer
 *   path — a keyboard-driven snap, say) still lights the indicator up.
 *
 * Neither path imports the snap plugin, and neither breaks if it is absent.
 */
export function snapIndicatorControl(): Control {
  return {
    id: 'snap-indicator',

    render(ctx: ControlContext): HTMLElement {
      const element = el('div', {
        class: 'fx-ui-snap',
        attrs: { role: 'tooltip', 'aria-live': 'polite' },
      })
      element.hidden = true

      // No capability check, and none is needed: with no snap engine installed,
      // `ctx.snap` is never set and no `snap:*` event is ever emitted, so the
      // indicator stays hidden and this control does precisely nothing. That is a
      // better kind of degradation than an `if (has('snap'))` — it also works for a
      // snap engine installed *after* the UI, and for one that isn't called "snap".
      const show = (snap: SnapSample | undefined, screen: { x: number; y: number }): void => {
        if (!snap) {
          element.hidden = true
          return
        }
        // Cursor coordinates are data, not design — the one thing this package sets
        // inline. Everything themeable is a var(--fx-*) in the stylesheet.
        element.style.setProperty('--fx-ui-x', `${screen.x}px`)
        element.style.setProperty('--fx-ui-y', `${screen.y}px`)
        element.textContent = labelFor(ctx, snap)
        element.hidden = false
      }

      ctx.disposables.add(ctx.pointer.on((sample) => show(sample.snap, sample.screen)))

      ctx.disposables.add(
        ctx.events.onAny('snap:*', (event) => {
          const snap = readSnap(event.payload)
          // `null` payload means "snap lost"; `undefined` means the event carried
          // nothing we understand, and an event we do not understand must not blank
          // an indicator the pointer feed is keeping correct.
          if (snap === undefined) return
          const screen = ctx.pointer.current?.screen ?? { x: 0, y: 0 }
          show(snap ?? undefined, screen)
        }),
      )

      return element
    },
  }
}

function labelFor(ctx: ControlContext, snap: SnapSample): string {
  // The engine's own hint wins: it is already localised, and it knows more than we
  // do ("parcel corner" beats "vertex").
  if (snap.hint !== undefined && snap.hint !== '') return snap.hint
  const key = `snap.kind.${snap.kind}`
  const translated = ctx.i18n.t(key)
  return translated === key ? snap.kind : translated
}

/**
 * Pull a snap out of an unknown event payload.
 *
 * Structural, because the alternative is importing the snap plugin's types, and
 * an optional dependency you have to import is not optional. Returns `null` for an
 * explicit "no snap", `undefined` for "this payload is not about a snap".
 */
function readSnap(payload: unknown): SnapSample | null | undefined {
  if (payload === null || typeof payload !== 'object') return undefined

  const record = payload as Record<string, unknown>
  const source =
    'candidate' in record ? record['candidate'] : 'snap' in record ? record['snap'] : record

  if (source === null || source === undefined) return null
  if (typeof source !== 'object') return undefined

  const candidate = source as Record<string, unknown>
  const kind = candidate['kind']
  if (typeof kind !== 'string') return undefined

  const hint = candidate['hint']
  return { kind, hint: typeof hint === 'string' ? hint : undefined }
}
