import type { Disposable, DisposableStore, PluginContext } from '@fleximap/core'

/** The four corners of the map container. Anything else is the host app's job, not ours. */
export type ControlPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/**
 * Where a control's element is actually attached.
 *
 * `'overlay'` is a full-bleed, pointer-transparent layer used by controls that
 * anchor themselves to the *cursor* rather than to a corner — the snap indicator.
 * It is deliberately not part of {@link ControlPosition}: a user asking for a
 * corner should get a corner, and a cursor-anchored control is not something you
 * position by hand.
 */
export type MountSlot = ControlPosition | 'overlay'

/**
 * A piece of UI.
 *
 * This is the whole extension point, and it is small on purpose. `render` returns
 * one element; the plugin owns where it goes and when it dies. Anything the
 * control subscribes to goes into `ctx.disposables` — a *control-scoped* store,
 * so removing one control does not tear down the others, and destroying the
 * plugin tears down all of them (core invariant 5).
 */
export interface Control {
  readonly id: string
  render(ctx: ControlContext): HTMLElement
  /** Exotic cleanup only. The element is removed and `ctx.disposables` is disposed for you. */
  destroy?(): void
}

/** A built-in control, optionally pinned to a corner other than its default. */
export type ControlSpec = Control | readonly [control: Control, position: ControlPosition]

/**
 * What a control is handed. A plugin context, with three additions and one
 * substitution:
 *
 * - `disposables` is **scoped to this control**, not to the plugin.
 * - `ui` is the plugin's own API, so a control can write to the status bar.
 * - `pointer` is the live pointer feed (see {@link PointerFeed}).
 * - `root` is the UI root element, for controls that need to measure against it.
 */
export interface ControlContext extends PluginContext<ResolvedUiOptions> {
  readonly ui: UiApi
  readonly pointer: PointerFeed
  readonly root: HTMLElement
  /**
   * The toolbar's state. It lives on the plugin rather than in the Toolbar
   * control's closure, because `api.toolbar.addButton()` has to work when no
   * toolbar is mounted — and a toolbar mounted later must show the buttons added
   * before it existed.
   */
  readonly toolbarModel: ToolbarModel
}

/**
 * The cursor, after the interaction pipeline has had its say.
 *
 * One middleware feeds every control that cares about the pointer, rather than
 * each control installing its own. The position is the *post-pipeline* one — it
 * has already been snapped and grid-locked — because that is where the vertex
 * will actually land, and a readout that shows a different number from the one
 * that gets stored is worse than no readout at all.
 */
export interface PointerFeed {
  /** `undefined` until the pointer first enters the map. */
  readonly current: PointerSample | undefined
  on(handler: (sample: PointerSample) => void): Disposable
}

export interface PointerSample {
  readonly lngLat: readonly [number, number]
  readonly screen: { readonly x: number; readonly y: number }
  /** The snap the engine settled on, if a snap plugin is installed. */
  readonly snap: SnapSample | undefined
}

/** The bit of `SnapResult` the UI needs, kept structural so any snap engine satisfies it. */
export interface SnapSample {
  readonly kind: string
  readonly hint?: string | undefined
}

/** A toolbar button. Everything themeable comes from CSS; everything textual from i18n. */
export interface ToolbarButton {
  readonly id: string
  /**
   * i18n key for the label and the aria-label. Falls back to {@link label}, then
   * to the id — so a missing translation is ugly, never fatal.
   */
  readonly labelKey?: string
  readonly label?: string
  /** A glyph. Set as `textContent`, never as HTML — a toolbar is not an XSS sink. */
  readonly icon?: string
  /** Clicking activates this tool, and the button carries `aria-pressed` while it is active. */
  readonly toolId?: string
  readonly onClick?: () => void
  /** Ascending. Tool-derived buttons default to 0; ties keep registration order. */
  readonly order?: number
}

export interface UiApi {
  /** Mount a control. Dispose the return value to remove just that control. */
  addControl(control: Control, position?: ControlPosition): Disposable

  readonly toolbar: {
    addButton(button: ToolbarButton): Disposable
    /** Force the pressed button. `null` clears it. Tool activation does this for you. */
    setActive(id: string | null): void
  }

  /**
   * The status line. Keyed, so two plugins writing to it cannot clobber each
   * other — `status.set('measure', '…')` and `status.set('hint', '…')` coexist.
   */
  readonly status: {
    set(key: string, text: string): void
    clear(key: string): void
  }

  readonly root: HTMLElement
}

export interface UiOptions {
  /**
   * Where to mount. Defaults to the map container, which is what you want: the
   * theme's CSS custom properties are written there, so the UI inherits the
   * map's palette for free.
   *
   * Pass an element to mount the chrome somewhere else (an app shell's sidebar,
   * say). The tokens are mirrored onto the root in that case, so the palette
   * still matches.
   */
  readonly container?: HTMLElement

  /**
   * Which controls to mount. Omit for the default set; pass `[]` for a bare root
   * you fill yourself with `addControl`.
   */
  readonly controls?: readonly ControlSpec[]

  /** Shown by the attribution control. */
  readonly attributions?: readonly string[]

  /** Register the plugin's own `ui.*` / `snap.kind.*` strings. Default `true`. */
  readonly messages?: boolean
}

/** Options after defaults. What a control actually sees on `ctx.options`. */
export interface ResolvedUiOptions extends UiOptions {
  readonly attributions: readonly string[]
  readonly messages: boolean
}

/** Internal: the shared toolbar state, so `api.toolbar` works whether or not a toolbar is mounted. */
export interface ToolbarModel {
  readonly buttons: readonly ToolbarButton[]
  readonly active: string | null
  readonly activeTool: string | null
  addButton(button: ToolbarButton): Disposable
  setActive(id: string | null): void
  /** Re-derive the tool-backed buttons from `tools.list()`. */
  refresh(): void
  onChange(handler: () => void): Disposable
  readonly disposables: DisposableStore
}
