import { el } from '../dom.js'
import type { Control, ControlContext } from '../types.js'

export interface AttributionOptions {
  /** Overrides `UiOptions.attributions`. */
  readonly attributions?: readonly string[]
  readonly separator?: string
}

/**
 * Data attribution.
 *
 * Plain text, set as `textContent`. Every other mapping library renders
 * attribution as HTML so that it can carry a link — and every one of them has had
 * the resulting XSS advisory, because attribution strings come from style JSON,
 * which comes from a URL, which comes from a config file somebody's CMS wrote.
 * A product that needs a clickable link can compose one itself with `addControl`
 * and own that decision explicitly.
 */
export function attributionControl(options: AttributionOptions = {}): Control {
  return {
    id: 'attribution',

    render(ctx: ControlContext): HTMLElement {
      const separator = options.separator ?? ' | '
      const items = options.attributions ?? ctx.options.attributions

      const element = el('div', {
        class: 'bl-ui-attribution',
        text: items.join(separator),
        attrs: { role: 'contentinfo', 'aria-label': ctx.i18n.t('ui.attribution') },
      })
      element.hidden = items.length === 0

      ctx.disposables.add(
        ctx.i18n.onChange(() => element.setAttribute('aria-label', ctx.i18n.t('ui.attribution'))),
      )

      return element
    },
  }
}
