import { el } from '../dom.js'
import type { Control, ControlContext } from '../types.js'

/**
 * The live measurement.
 *
 * **Optional dependency on the measure plugin.** Without it, nothing ever emits a
 * `measure:*` event, and this control renders a hidden element and subscribes to
 * nothing.
 *
 * The *number* is not computed here, and that is deliberate: area and length are
 * survey-grade quantities that must be computed in the projected working CRS
 * (invariant 3), and the measure plugin already does that. A UI package that
 * recomputed them "for display" would eventually disagree with the value that gets
 * stored, by a square metre, in a land dispute.
 */
export function measureReadoutControl(): Control {
  return {
    id: 'measure',

    render(ctx: ControlContext): HTMLElement {
      const element = el('div', {
        class: 'bl-ui-control bl-ui-readout bl-ui-measure',
        attrs: {
          'aria-label': ctx.i18n.t('ui.measure'),
          role: 'status',
          'aria-live': 'polite',
        },
      })
      element.hidden = true

      // As with the snap indicator: no capability check. A `measure:*` event cannot
      // fire unless a measure plugin is installed, so subscribing unconditionally
      // degrades to nothing — and works for a measure plugin installed later, which
      // an `if (has('measure'))` in `setup()` would have missed. (It would also have
      // been *wrong* half the time: the kernel installs a preset's plugins
      // concurrently, so "is measure installed yet" is a microtask race at setup.)
      ctx.disposables.add(
        ctx.events.onAny('measure:*', (event) => {
          const text = readText(ctx, event.payload)
          if (text === undefined) return
          element.textContent = text
          element.hidden = text === ''
          // The status line is the one place a product can put a measurement without
          // mounting this control at all — keep the two in step.
          if (text === '') ctx.ui.status.clear('measure')
          else ctx.ui.status.set('measure', text)
        }),
      )

      // Removing this control must also remove what it wrote elsewhere. A stale
      // measurement stuck in the status bar outlives the tool that produced it.
      ctx.disposables.addFn(() => ctx.ui.status.clear('measure'))

      return element
    },
  }
}

/**
 * Read a display string out of an unknown measure payload.
 *
 * A plugin that has already localised its own value (`text`) wins. Otherwise we
 * format the raw quantity through i18n, because `1.234,56 m²` and `1,234.56 m²`
 * are the same number and only one of them is right for the reader.
 *
 * Returns `undefined` for a payload that is not about a measurement — an event we
 * do not understand must not blank a reading the user is looking at.
 */
function readText(ctx: ControlContext, payload: unknown): string | undefined {
  if (payload === null || payload === undefined) return ''
  if (typeof payload !== 'object') return undefined

  const record = payload as Record<string, unknown>

  const text = record['text'] ?? record['label']
  if (typeof text === 'string') return text

  const area = record['area']
  if (typeof area === 'number' && Number.isFinite(area)) return ctx.i18n.area(area)

  const length = record['length'] ?? record['distance']
  if (typeof length === 'number' && Number.isFinite(length)) {
    return `${ctx.i18n.number(length, { maximumFractionDigits: 3 })} ${ctx.i18n.t('units.metre')}`
  }

  // An explicit "no measurement": a cleared or cancelled gesture.
  if ('area' in record || 'length' in record || 'text' in record) return ''
  return undefined
}
