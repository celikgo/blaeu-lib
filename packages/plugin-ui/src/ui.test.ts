// @vitest-environment jsdom
//
// The one package in the monorepo that genuinely needs a DOM. Everything else runs
// in the node environment on purpose — a plugin that quietly reaches for
// `document.body` should be caught by the test suite, not shipped.

import { describe, expect, it, beforeEach } from 'vitest'
import { createTestMap, type TestMap } from '@fleximap/core/testing'
import type { FlexiPlugin, Tool, ValidationIssue } from '@fleximap/core'
import { uiPlugin, toolbarControl, type UiApi } from './index.js'

/* ========================================================================= */
/* Doubles                                                                   */
/* ========================================================================= */

/** A tool that does nothing. The toolbar must show it anyway — that is the point. */
function inertTool(): Tool {
  return { id: 'x', activate: () => {}, deactivate: () => {} }
}

/**
 * A plugin the UI has never heard of, registering a tool the UI has never heard
 * of. If its button appears in the toolbar, the extension point is real.
 */
function strangerPlugin(toolId: string): FlexiPlugin<void, unknown> {
  return {
    id: 'stranger',
    version: '1.0.0',
    setup(ctx) {
      ctx.disposables.add(ctx.tools.register(toolId, inertTool()))
    },
  }
}

/** Stands in for the history plugin, exposing just enough shape for the buttons. */
function fakeHistoryPlugin(): FlexiPlugin<
  { canUndo: boolean; canRedo: boolean; undo(): void },
  unknown
> {
  return {
    id: 'history',
    version: '1.0.0',
    setup() {
      return {
        canUndo: false,
        canRedo: false,
        undo() {},
      }
    },
  }
}

/* ========================================================================= */

function container(map: TestMap): HTMLElement {
  return map.test.renderer.container!
}

function ui(map: TestMap): UiApi {
  return map.plugin('ui')
}

function buttons(map: TestMap): HTMLButtonElement[] {
  return [...ui(map).root.querySelectorAll<HTMLButtonElement>('[role="toolbar"] .fx-ui-button')]
}

describe('uiPlugin', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    document.head.replaceChildren()
  })

  it('mounts its root into the map container and finds it without being told', async () => {
    const map = await createTestMap({ plugins: [uiPlugin()] })

    expect(ui(map).root.parentElement).toBe(container(map))
    expect(document.head.querySelector('style[data-fx-ui-style]')).not.toBeNull()

    await map.destroy()
  })

  /* ---------------------------------------------------------------- test 1 */

  describe('degradation', () => {
    it('works with no snap, history, topology or measure plugin installed', async () => {
      const map = await createTestMap({ plugins: [uiPlugin()] })

      // The chrome that needs no help is there…
      expect(ui(map).root.querySelector('[role="toolbar"]')).not.toBeNull()
      expect(ui(map).root.querySelector('.fx-ui-coordinates')).not.toBeNull()
      expect(ui(map).root.querySelector('.fx-ui-scale')).not.toBeNull()

      // …and the chrome that needs an absent plugin is present but hidden, with
      // nothing subscribed to an event that will never fire.
      expect(ui(map).root.querySelector<HTMLElement>('.fx-ui-snap')?.hidden).toBe(true)
      expect(ui(map).root.querySelector<HTMLElement>('.fx-ui-measure')?.hidden).toBe(true)

      // And the map still works: a pointer move drives the readout.
      map.test.pointerMove([32.8501, 39.9301])
      const readout = ui(map).root.querySelector('.fx-ui-coordinates')
      expect(readout?.textContent).not.toBe('—')
      expect(readout?.textContent?.length).toBeGreaterThan(0)

      await map.destroy()
    })

    it('enables the history buttons only when a history plugin is installed', async () => {
      const without = await createTestMap({ plugins: [uiPlugin()] })
      expect(
        ui(without).root.querySelector<HTMLElement>('.fx-ui-toolbar[role="group"]')?.hidden,
      ).toBe(true)
      await without.destroy()

      const map = await createTestMap({ plugins: [fakeHistoryPlugin(), uiPlugin()] })
      const group = ui(map).root.querySelector<HTMLElement>('.fx-ui-toolbar[role="group"]')
      expect(group?.hidden).toBe(false)
      // canUndo is false on the fake, so the button reports itself unavailable.
      expect(group?.querySelector<HTMLButtonElement>('.fx-ui-button')?.disabled).toBe(true)

      await map.destroy()
    })
  })

  /* ---------------------------------------------------------------- test 2 */

  describe('teardown', () => {
    it('leaks nothing on removal', async () => {
      const map = await createTestMap()
      // The baseline is the map *before* the plugin, not zero: the kernel itself
      // keeps listeners (the store→renderer bridge, for one). Asserting `listeners:
      // 0` would be asserting something false about the core.
      const baseline = map.debug.snapshot()

      await map.use(uiPlugin())
      expect(map.debug.snapshot()['listeners']).toBeGreaterThan(baseline['listeners']!)
      expect(map.debug.snapshot()['middleware']).toBe(baseline['middleware']! + 1)

      await map.remove('ui')

      expect(map.debug.snapshot()).toEqual(baseline)
      expect(container(map).querySelector('.fx-ui')).toBeNull()
      expect(document.head.querySelector('style[data-fx-ui-style]')).toBeNull()

      await map.destroy()
    })

    it('removes only the control that was disposed', async () => {
      const map = await createTestMap({ plugins: [uiPlugin({ controls: [] })] })
      const before = map.debug.snapshot()['listeners']!

      const handle = ui(map).addControl(toolbarControl())
      expect(ui(map).root.querySelector('[role="toolbar"]')).not.toBeNull()

      handle.dispose()
      expect(ui(map).root.querySelector('[role="toolbar"]')).toBeNull()
      expect(map.debug.snapshot()['listeners']).toBe(before)

      await map.destroy()
    })
  })

  /* ---------------------------------------------------------------- test 3 */

  describe('undo round-trip', () => {
    it('mutates nothing, so there is nothing to undo', async () => {
      const map = await createTestMap({ plugins: [uiPlugin()] })
      const before = map.store.snapshot()

      // The chrome is exercised hard: pointer moves, a tool activated from a
      // toolbar button, a status write, a locale switch.
      map.tools.register('draw:polygon', inertTool())
      ui(map).toolbar.setActive(null)
      map.test.pointerMove([32.85, 39.93])
      buttons(map)[0]?.click()
      ui(map).status.set('hint', 'anything')
      map.i18n.setLocale('tr')

      // Deep equality, not "close enough". A UI plugin that writes to the store has
      // a bug: state changes go through commands, and this one has none.
      expect(map.store.snapshot()).toEqual(before)

      await map.destroy()
    })
  })

  /* ------------------------------------------------------------------ toolbar */

  describe('toolbar', () => {
    it('shows a tool registered by a plugin it has never heard of', async () => {
      const map = await createTestMap({
        plugins: [uiPlugin(), strangerPlugin('stranger:hex-paint')],
      })

      const node = buttons(map).find((b) => b.dataset['fxId'] === 'stranger:hex-paint')
      expect(node).toBeDefined()
      // No translation registered for it, so the label falls back to the tool id —
      // never to the raw i18n key.
      expect(node?.textContent).toBe('stranger:hex-paint')

      await map.destroy()
    })

    it('labels buttons from i18n, so a preset can rename a tool it does not own', async () => {
      const map = await createTestMap({ plugins: [uiPlugin()] })
      map.i18n.register('tr', { 'tool.draw:polygon': 'Parsel çiz' })
      map.i18n.setLocale('tr')

      map.tools.register('draw:polygon', inertTool())
      // Registering a tool is not an event; a plugin install is. Presets install
      // their tools during setup, which is why this is enough in practice.
      map.events.emit('plugin:registered', { id: 'draw' })

      const node = buttons(map).find((b) => b.dataset['fxId'] === 'draw:polygon')
      expect(node?.textContent).toBe('Parsel çiz')
      expect(node?.getAttribute('aria-label')).toBe('Parsel çiz')

      await map.destroy()
    })

    it('activates a tool on click and carries aria-pressed while it is active', async () => {
      const map = await createTestMap({
        plugins: [uiPlugin(), strangerPlugin('stranger:hex-paint')],
      })

      const node = (): HTMLButtonElement =>
        buttons(map).find((b) => b.dataset['fxId'] === 'stranger:hex-paint')!

      expect(node().getAttribute('aria-pressed')).toBe('false')

      node().click()
      expect(map.tools.active).toBe('stranger:hex-paint')
      expect(node().getAttribute('aria-pressed')).toBe('true')

      // A second click puts the tool down, as every drawing program does.
      node().click()
      expect(map.tools.active).toBeNull()
      expect(node().getAttribute('aria-pressed')).toBe('false')

      await map.destroy()
    })

    it('tracks a tool activated from outside the toolbar', async () => {
      const map = await createTestMap({
        plugins: [uiPlugin(), strangerPlugin('stranger:hex-paint')],
      })

      map.tools.activate('stranger:hex-paint')
      const node = buttons(map).find((b) => b.dataset['fxId'] === 'stranger:hex-paint')
      expect(node?.getAttribute('aria-pressed')).toBe('true')

      await map.destroy()
    })

    it('is one tab stop, and arrow keys move within it', async () => {
      const map = await createTestMap({
        plugins: [uiPlugin(), strangerPlugin('stranger:a')],
      })
      // Focus only lands on elements that are in the document.
      document.body.appendChild(container(map))
      map.tools.register('stranger:b', inertTool())
      map.events.emit('plugin:registered', { id: 'other' })

      const list = buttons(map)
      expect(list.length).toBe(2)
      expect(list.map((b) => b.tabIndex)).toEqual([0, -1])

      list[0]!.focus()
      list[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      expect(document.activeElement).toBe(list[1])
      expect(list.map((b) => b.tabIndex)).toEqual([-1, 0])

      list[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      expect(document.activeElement).toBe(list[0])

      // Tab is not ours. A toolbar that swallows it traps the keyboard user inside.
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      list[0]!.dispatchEvent(tab)
      expect(tab.defaultPrevented).toBe(false)

      await map.destroy()
    })

    it('keeps a custom button and does not duplicate its tool', async () => {
      const map = await createTestMap({
        plugins: [uiPlugin(), strangerPlugin('stranger:hex-paint')],
      })

      let clicked = 0
      const handle = ui(map).toolbar.addButton({
        id: 'stranger:hex-paint',
        label: 'Paint',
        toolId: 'stranger:hex-paint',
        onClick: () => clicked++,
      })

      const matching = buttons(map).filter((b) => b.dataset['fxId'] === 'stranger:hex-paint')
      expect(matching.length).toBe(1)
      expect(matching[0]?.textContent).toBe('Paint')

      matching[0]!.click()
      expect(clicked).toBe(1)
      expect(map.tools.active).toBe('stranger:hex-paint')

      handle.dispose()
      // The generated button comes back once the custom one is gone.
      expect(
        buttons(map).find((b) => b.dataset['fxId'] === 'stranger:hex-paint')?.textContent,
      ).toBe('stranger:hex-paint')

      await map.destroy()
    })
  })

  /* ---------------------------------------------------------------- readouts */

  describe('coordinate readout', () => {
    it('formats through crs.format(), honouring config.crs.display', async () => {
      const map = await createTestMap({
        plugins: [uiPlugin()],
        config: { crs: { working: 'EPSG:5254', display: 'projected' } },
      })

      map.test.pointerMove([32.8501, 39.9301])
      const text = ui(map).root.querySelector('.fx-ui-coordinates')?.textContent ?? ''

      // The exact numbers are the CRS service's business, not ours — what this
      // package owes is that it asked the CRS service rather than printing degrees.
      expect(text).toBe(map.crs.format([32.8501, 39.9301]))
      expect(text).toMatch(/^Y=/)

      await map.destroy()
    })
  })

  describe('issue panel', () => {
    it('lists validation issues and flies the camera to the one clicked', async () => {
      const map = await createTestMap({ plugins: [uiPlugin()] })

      const issue: ValidationIssue = {
        rule: 'cadastre:no-overlap',
        severity: 'error',
        message: 'Parcels overlap by 2.31 m²',
        feature: 'A',
        at: [32.86, 39.94],
      }
      map.events.emit('validation:failed', { issues: [issue] })

      const panel = ui(map).root.querySelector<HTMLElement>('.fx-ui-issues')
      expect(panel?.hidden).toBe(false)

      const row = panel?.querySelector<HTMLButtonElement>('.fx-ui-issue')
      expect(row?.textContent).toContain('overlap')
      expect(row?.className).toContain('fx-ui-issue-error')

      const before = map.test.renderer.setCameraCalls
      row?.click()
      expect(map.test.renderer.setCameraCalls).toBe(before + 1)
      expect(map.test.renderer.getCamera().center).toEqual([32.86, 39.94])

      await map.destroy()
    })
  })

  describe('status', () => {
    it('is keyed, so two writers cannot clobber each other', async () => {
      const map = await createTestMap({ plugins: [uiPlugin()] })

      ui(map).status.set('hint', 'Click to start')
      ui(map).status.set('measure', '124,50 m')
      expect(ui(map).root.querySelector('.fx-ui-status')?.textContent).toBe(
        'Click to start124,50 m',
      )

      ui(map).status.clear('hint')
      expect(ui(map).root.querySelector('.fx-ui-status')?.textContent).toBe('124,50 m')

      await map.destroy()
    })
  })

  describe('theme', () => {
    it('takes its palette from the theme tokens, and follows a theme change', async () => {
      const map = await createTestMap({ plugins: [uiPlugin()] })
      const root = ui(map).root

      expect(root.style.getPropertyValue('--fx-color-accent')).toBe(
        map.theme.current.tokens.color.accent,
      )

      map.theme.set({ tokens: { color: { accent: '#ff0000' } } })
      expect(root.style.getPropertyValue('--fx-color-accent')).toBe('#ff0000')

      await map.destroy()
    })
  })
})
