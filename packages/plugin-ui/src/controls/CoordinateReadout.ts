import { el } from '../dom.js'
import type { Control, ControlContext } from '../types.js'

/**
 * The cursor's position, in the working CRS.
 *
 * `crs.format()` decides the shape of the string, honouring `config.crs.display`
 * — so a cadastre product configured with `display: 'projected'` and
 * `working: 'EPSG:5254'` shows `Y=458123.456  X=4421987.123`, which is what a
 * Turkish surveyor reads and types, while a consumer map configured with
 * `display: 'decimal'` shows degrees. Formatting is not this control's business,
 * and the moment it becomes so, two places decide what a coordinate looks like.
 *
 * The position comes from the pointer feed, i.e. *after* snapping. See
 * `pointerFeed.ts` for why that is not a cosmetic choice.
 */
export function coordinateReadoutControl(): Control {
  return {
    id: 'coordinates',

    render(ctx: ControlContext): HTMLElement {
      const empty = (): string => ctx.i18n.t('ui.coordinates.empty')

      const element = el('div', {
        class: 'fx-ui-control fx-ui-readout fx-ui-coordinates fx-ui-readout-empty',
        text: empty(),
        attrs: {
          'aria-label': ctx.i18n.t('ui.coordinates'),
          // Polite, not assertive: this updates at pointer frequency, and an
          // assertive live region would make a screen reader talk over everything
          // else for as long as the mouse is moving.
          'aria-live': 'polite',
          'aria-atomic': 'true',
        },
      })

      const render = (): void => {
        const sample = ctx.pointer.current
        if (!sample) {
          element.textContent = empty()
          element.classList.add('fx-ui-readout-empty')
          return
        }
        element.classList.remove('fx-ui-readout-empty')
        element.textContent = ctx.crs.format(sample.lngLat)
      }

      render()
      ctx.disposables.add(ctx.pointer.on(render))
      // A locale switch changes the placeholder, and the number separators with it
      // — Turkish writes 458.123,456 where English writes 458,123.456.
      ctx.disposables.add(ctx.i18n.onChange(render))

      return element
    },
  }
}
