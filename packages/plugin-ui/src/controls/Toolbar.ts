import { button, el, listen } from '../dom.js'
import type { Control, ControlContext, ToolbarButton } from '../types.js'

/**
 * The tool buttons.
 *
 * Two properties are load-bearing and easy to lose in a refactor:
 *
 * 1. **It knows no tool by name.** Buttons are derived from `tools.list()` (via
 *    the shared toolbar model), so a tool registered by any plugin — including one
 *    written years from now — appears here with no code in this file.
 * 2. **It contains no English.** Labels come from `tool.<id>` through i18n, which
 *    is how the cadastre preset renames "Polygon" to "Parsel çiz" without this
 *    package containing a word of Turkish.
 *
 * Keyboard behaviour follows the ARIA authoring practice for a toolbar: one tab
 * stop for the whole group (a roving `tabindex`), arrows to move within it, Home
 * and End to jump. A clerk who lives in this UI eight hours a day should never
 * have to press Tab eleven times to reach the last tool.
 */
export function toolbarControl(): Control {
  /** Which button owns the group's single tab stop. Survives re-renders. */
  let focusIndex = 0

  return {
    id: 'toolbar',

    render(ctx: ControlContext): HTMLElement {
      const element = el('div', {
        class: 'bl-ui-control bl-ui-toolbar',
        attrs: {
          role: 'toolbar',
          'aria-label': ctx.i18n.t('ui.toolbar'),
          'aria-orientation': 'horizontal',
        },
      })

      const render = (): void => {
        focusIndex = renderButtons(ctx, element, focusIndex)
      }
      render()

      ctx.disposables.add(ctx.toolbarModel.onChange(render))
      // The toolbar is a view of the tools *as currently labelled*, so a locale
      // switch must redraw it — not merely restyle it.
      ctx.disposables.add(ctx.i18n.onChange(render))

      ctx.disposables.add(
        listen(element, 'keydown', (event) => {
          const moved = moveFocus(element, event)
          if (moved === undefined) return
          focusIndex = moved
          event.preventDefault()
        }),
      )

      return element
    },
  }
}

/* ------------------------------------------------------------------------- */

/** Redraws the buttons. Returns the (possibly clamped) focus index. */
function renderButtons(ctx: ControlContext, element: HTMLElement, focusIndex: number): number {
  const model = ctx.toolbarModel
  const list = model.buttons

  // A keyboard user tabs to a tool and presses Enter to activate it — which changes the toolbar
  // model and re-renders this control, replacing the very button they are standing on. Note
  // whether focus was inside the toolbar *before* the rebuild, so it can be handed back to the
  // tab-stop button afterwards rather than dropped to <body>, which ejects the user to the top of
  // the document on every activation.
  const hadFocus = element.contains(element.ownerDocument.activeElement)

  // Rebuilding the children drops the DOM listeners with them; the disposables
  // added below would otherwise pile up on every re-render, which — with a locale
  // switch and a tool change per second — is a leak with a slow fuse.
  element.replaceChildren()

  if (list.length === 0) {
    // An empty `role="toolbar"` is announced to a screen reader as an empty group.
    // That is noise, not information.
    element.hidden = true
    return 0
  }
  element.hidden = false

  const index = Math.min(Math.max(focusIndex, 0), list.length - 1)

  list.forEach((spec, i) => {
    const node = renderButton(ctx, spec, i === index)
    element.appendChild(node)
    // Restore keyboard focus to the tab stop after the rebuild, but only if the toolbar held it
    // to begin with — never steal focus from elsewhere on the page just because the tools changed.
    if (hadFocus && i === index) node.focus()
  })

  return index
}

function renderButton(ctx: ControlContext, spec: ToolbarButton, tabbable: boolean): HTMLElement {
  const model = ctx.toolbarModel
  const label = labelFor(ctx, spec)
  const node = button('bl-ui-button', label)
  node.dataset['fxId'] = spec.id

  if (spec.icon !== undefined) {
    node.appendChild(
      el('span', {
        class: 'bl-ui-button-icon',
        text: spec.icon,
        attrs: { 'aria-hidden': 'true' },
      }),
    )
  }
  node.appendChild(el('span', { class: 'bl-ui-button-label', text: label }))

  // `aria-pressed` goes only on buttons that genuinely are toggles. On a button
  // that merely fires an action it tells a screen-reader user there is a state to
  // toggle when there is not.
  if (spec.toolId !== undefined) {
    const pressed = spec.id === model.active || spec.toolId === model.activeTool
    node.setAttribute('aria-pressed', pressed ? 'true' : 'false')
  }

  node.tabIndex = tabbable ? 0 : -1
  node.addEventListener('click', () => activate(ctx, spec))
  return node
}

function activate(ctx: ControlContext, spec: ToolbarButton): void {
  if (spec.toolId !== undefined) {
    // A second click on the active tool puts the tool down, which is what every
    // user of every drawing program already expects.
    if (ctx.toolbarModel.activeTool === spec.toolId) ctx.tools.deactivate()
    else ctx.tools.activate(spec.toolId)
  }
  spec.onClick?.()
}

function labelFor(ctx: ControlContext, spec: ToolbarButton): string {
  if (spec.labelKey !== undefined) {
    const translated = ctx.i18n.t(spec.labelKey)
    // `t()` returns the key itself when there is no translation. Rendering a raw
    // `tool.draw:polygon` in a toolbar is worse than rendering `draw:polygon`,
    // which at least names the tool.
    if (translated !== spec.labelKey) return translated
  }
  return spec.label ?? spec.toolId ?? spec.id
}

/**
 * Arrow keys, Home and End. Returns the new focus index, or `undefined` if the key
 * was not ours — a toolbar that swallows Tab traps the keyboard user inside it.
 */
function moveFocus(element: HTMLElement, event: KeyboardEvent): number | undefined {
  const nodes = [...element.querySelectorAll<HTMLButtonElement>('.bl-ui-button')]
  if (nodes.length === 0) return undefined

  const current = nodes.findIndex((node) => node === element.ownerDocument.activeElement)
  const from = current < 0 ? 0 : current

  let next: number
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = (from + 1) % nodes.length
      break
    case 'ArrowLeft':
    case 'ArrowUp':
      next = (from - 1 + nodes.length) % nodes.length
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = nodes.length - 1
      break
    default:
      return undefined
  }

  const target = nodes[next]
  if (!target) return undefined

  for (const node of nodes) node.tabIndex = node === target ? 0 : -1
  target.focus()
  return next
}
