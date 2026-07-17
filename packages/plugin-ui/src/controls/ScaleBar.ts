import { el } from '../dom.js'
import type { Control, ControlContext } from '../types.js'

/** The bar never exceeds this, in CSS pixels. */
const MAX_WIDTH_PX = 110

/** 1-2-5, the standard progression for a scale bar: every step is a number a human rounds to. */
const STEPS = [1, 2, 5]

export interface ScaleBarOptions {
  readonly maxWidthPx?: number
}

/**
 * The scale bar.
 *
 * The distance is measured through `crs.distance()`, i.e. planar metres in the
 * working CRS — **not** a spherical approximation. On a cadastral map at 1:500
 * the difference between the two is visible in the bar's own width, and a scale
 * bar that is wrong is worse than none: it is the thing a user holds a ruler
 * against.
 */
export function scaleBarControl(options: ScaleBarOptions = {}): Control {
  const maxWidth = options.maxWidthPx ?? MAX_WIDTH_PX

  return {
    id: 'scale',

    render(ctx: ControlContext): HTMLElement {
      const bar = el('div', { class: 'bl-ui-scale-bar' })
      const label = el('span', { class: 'bl-ui-scale-label' })

      const element = el('div', {
        class: 'bl-ui-scale',
        attrs: { 'aria-label': ctx.i18n.t('ui.scale'), role: 'img' },
        children: [bar, label],
      })

      const render = (): void => {
        const scale = measure(ctx, maxWidth)
        if (!scale) {
          element.hidden = true
          return
        }
        element.hidden = false
        // The *width* of the bar is a measurement, not a design token — the one
        // legitimate inline style here, exactly as with the snap indicator's
        // position.
        bar.style.width = `${scale.widthPx}px`

        const text = `${ctx.i18n.number(scale.metres)} ${ctx.i18n.t('units.metre')}`
        label.textContent = text
        element.setAttribute('aria-label', `${ctx.i18n.t('ui.scale')}: ${text}`)
      }

      render()
      ctx.disposables.add(ctx.events.on('camera:move', render))
      ctx.disposables.add(ctx.events.on('camera:idle', render))
      ctx.disposables.add(ctx.events.on('map:ready', render))
      // Turkish writes 1.000 where English writes 1,000. Same bar, different number.
      ctx.disposables.add(ctx.i18n.onChange(render))

      return element
    },
  }
}

/** Metres per `maxWidth` pixels, rounded down to the nearest 1/2/5 × 10ⁿ. */
function measure(
  ctx: ControlContext,
  maxWidth: number,
): { readonly metres: number; readonly widthPx: number } | undefined {
  const camera = ctx.renderer.getCamera()
  const origin = ctx.renderer.project(camera.center)

  const a = ctx.renderer.unproject(origin)
  const b = ctx.renderer.unproject({ x: origin.x + maxWidth, y: origin.y })
  const span = ctx.crs.distance(a, b)

  // A degenerate camera (zero-size container before layout, a renderer not yet
  // mounted) yields 0 or NaN. Hide the bar rather than render "NaN m".
  if (!Number.isFinite(span) || span <= 0) return undefined

  const magnitude = Math.pow(10, Math.floor(Math.log10(span)))
  let metres = magnitude
  for (const step of STEPS) {
    if (step * magnitude <= span) metres = step * magnitude
  }

  return { metres, widthPx: Math.round((metres / span) * maxWidth) }
}
