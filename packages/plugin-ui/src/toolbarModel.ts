import { DisposableStore, type Disposable, type PluginContext } from '@blaeu/core'
import type { ResolvedUiOptions, ToolbarButton, ToolbarModel } from './types.js'

/**
 * The toolbar's state, kept out of the toolbar's DOM.
 *
 * `api.toolbar.addButton()` must work whether or not a Toolbar control happens to
 * be mounted — a preset that hides the toolbar and drives tools from its own
 * chrome should not crash, and a toolbar mounted *later* should show buttons
 * added earlier. So the buttons live here and the control renders them.
 *
 * ### Where the buttons come from
 *
 * They are **derived from `tools.list()`**, not enumerated. Any plugin — including
 * one written years from now by someone who has never read this file — that calls
 * `ctx.tools.register('cadastre:split-parcel', …)` gets a toolbar button, with a
 * label from `tool.cadastre:split-parcel` and a working `aria-pressed`, and this
 * package contains not one line about it. If that had to be wired by hand here,
 * the extension point would be decorative.
 *
 * The awkward bit: `ToolManager` has no `tool:registered` event, so there is
 * nothing to subscribe to. We re-derive on `plugin:registered` / `plugin:removed`
 * / `map:ready` (which is when plugins install their tools) and, defensively, on
 * `tool:activated` — a tool cannot become active without existing. A
 * `tool:registered` event in the core would let this be exact instead of
 * inferred; see the README.
 */
export class SharedToolbarModel implements ToolbarModel {
  readonly disposables = new DisposableStore()

  #custom: ToolbarButton[] = []
  #tools: readonly string[] = []
  #active: string | null = null
  #activeTool: string | null = null
  #handlers: (() => void)[] = []

  readonly #ctx: PluginContext<ResolvedUiOptions>

  constructor(ctx: PluginContext<ResolvedUiOptions>) {
    this.#ctx = ctx
    this.#activeTool = ctx.tools.active
    this.#tools = ctx.tools.list()

    const rederive = (): void => this.refresh()
    this.disposables.add(ctx.events.on('plugin:registered', rederive))
    this.disposables.add(ctx.events.on('plugin:removed', rederive))
    this.disposables.add(ctx.events.on('map:ready', rederive))

    this.disposables.add(
      ctx.events.on('tool:activated', (event) => {
        this.#activeTool = event.payload.id
        this.#active = event.payload.id
        this.refresh()
      }),
    )
    this.disposables.add(
      ctx.events.on('tool:deactivated', () => {
        this.#activeTool = null
        this.#active = null
        this.#emit()
      }),
    )
  }

  get buttons(): readonly ToolbarButton[] {
    const derived: ToolbarButton[] = this.#tools
      // A tool that already has a custom button must not get a second, generated
      // one — the user would see the same tool twice.
      .filter((id) => !this.#custom.some((b) => b.toolId === id || b.id === id))
      .map((id) => ({ id, toolId: id, labelKey: `tool.${id}`, order: 0 }))

    return [...derived, ...this.#custom].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  get active(): string | null {
    return this.#active
  }

  get activeTool(): string | null {
    return this.#activeTool
  }

  addButton(button: ToolbarButton): Disposable {
    this.#custom.push(button)
    this.#emit()
    return {
      dispose: () => {
        const i = this.#custom.indexOf(button)
        if (i < 0) return
        this.#custom.splice(i, 1)
        this.#emit()
      },
    }
  }

  setActive(id: string | null): void {
    if (this.#active === id) return
    this.#active = id
    this.#emit()
  }

  /**
   * Emits unconditionally, even when the tool set is unchanged: a refresh also
   * carries a possibly-new active tool, and a control that re-renders a handful
   * of buttons is cheaper than the bookkeeping needed to prove it needn't.
   */
  refresh(): void {
    this.#tools = this.#ctx.tools.list()
    this.#emit()
  }

  onChange(handler: () => void): Disposable {
    this.#handlers.push(handler)
    return {
      dispose: () => {
        const i = this.#handlers.indexOf(handler)
        if (i >= 0) this.#handlers.splice(i, 1)
      },
    }
  }

  #emit(): void {
    for (const handler of [...this.#handlers]) handler()
  }
}
