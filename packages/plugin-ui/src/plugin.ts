import {
  DisposableStore,
  type Disposable,
  type FlexiPlugin,
  type PluginContext,
} from '@fleximap/core'

import { attributionControl } from './controls/AttributionControl.js'
import { coordinateReadoutControl } from './controls/CoordinateReadout.js'
import { historyButtonsControl } from './controls/HistoryButtons.js'
import { issuePanelControl } from './controls/IssuePanel.js'
import { measureReadoutControl } from './controls/MeasureReadout.js'
import { scaleBarControl } from './controls/ScaleBar.js'
import { snapIndicatorControl } from './controls/SnapIndicator.js'
import { toolbarControl } from './controls/Toolbar.js'
import { el } from './dom.js'
import { en, tr } from './messages.js'
import { InteractionPointerFeed } from './pointerFeed.js'
import { stylesheet } from './styles.js'
import { SharedToolbarModel } from './toolbarModel.js'
import { applyTokens } from './tokens.js'
import type {
  Control,
  ControlContext,
  ControlPosition,
  ControlSpec,
  MountSlot,
  ResolvedUiOptions,
  ToolbarButton,
  UiApi,
  UiOptions,
} from './types.js'

/** Unique per plugin instance, so two maps on one page cannot inherit each other's CSS. */
let scopeCounter = 0

const POSITIONS: readonly ControlPosition[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
]

/**
 * Where each built-in goes when the caller does not say.
 *
 * The snap indicator is the interesting one: it anchors to the *cursor*, so it
 * lives on the overlay layer rather than in a corner. That is why {@link MountSlot}
 * is wider than {@link ControlPosition} — the public API offers four corners
 * because four corners is what a user should be choosing between.
 */
const DEFAULT_SLOT: Readonly<Record<string, MountSlot>> = {
  toolbar: 'top-left',
  history: 'top-left',
  measure: 'top-right',
  issues: 'top-right',
  coordinates: 'bottom-left',
  scale: 'bottom-left',
  attribution: 'bottom-right',
  'snap-indicator': 'overlay',
}

/**
 * Framework-free map chrome.
 *
 * Vanilla DOM, styled entirely by the CSS custom properties the core's
 * ThemeManager writes. There is no React here and no Vue, and that is a decision
 * rather than an omission: this is a library, and picking a framework at this
 * layer halves its addressable audience on the day it ships. A React wrapper is a
 * separate package, and it is a thin one — `useEffect` around `addControl`.
 *
 * Every optional dependency really is optional. Install this with no snap, no
 * history, no topology and no measure plugin and you get a toolbar, a coordinate
 * readout, a scale bar and an attribution line — nothing throws, nothing is
 * disabled that shouldn't be, and no listener is left dangling on an event that
 * will never fire.
 */
export function uiPlugin(options: UiOptions = {}): FlexiPlugin<UiApi, UiOptions> {
  return {
    id: 'ui',
    version: '1.0.0',
    dependencies: [
      // All optional. Each one *enhances* the chrome; none of them is needed for it.
      { id: 'snap', optional: true },
      { id: 'history', optional: true },
      { id: 'topology', optional: true },
      { id: 'measure', optional: true },
    ],

    setup(ctx: PluginContext<UiOptions>): UiApi {
      return build(withDefaults(ctx, options))
    },
  }
}

/* ========================================================================= */
/* Construction                                                              */
/* ========================================================================= */

function withDefaults(
  ctx: PluginContext<UiOptions>,
  factoryOptions: UiOptions,
): PluginContext<ResolvedUiOptions> {
  // The plugin manager merges nothing: `ctx.options` is whatever the *installer*
  // passed (a preset's `[uiPlugin, { … }]` tuple), which may be nothing at all,
  // while `factoryOptions` is what the caller wrote at `uiPlugin({ … })`. The
  // installer wins, because that is the one a preset can override.
  const merged: UiOptions = { ...factoryOptions, ...(ctx.options as UiOptions | undefined) }

  const options: ResolvedUiOptions = {
    ...merged,
    attributions: merged.attributions ?? [],
    messages: merged.messages ?? true,
  }
  return { ...ctx, options }
}

function build(ctx: PluginContext<ResolvedUiOptions>): UiApi {
  const container = resolveContainer(ctx)

  if (ctx.options.messages) {
    ctx.disposables.add(ctx.i18n.register('en', en))
    ctx.disposables.add(ctx.i18n.register('tr', tr))
  }

  // No DOM: server-side rendering, or the node-environment test run that most of
  // this monorepo uses. The plugin installs, its API is present and inert, and a
  // preset that bundles it does not explode. Failing loudly here would make the UI
  // plugin uninstallable in exactly the environments that legitimately have no
  // screen.
  if (typeof document === 'undefined') {
    ctx.log.debug(
      'no document — the UI is inert. This is expected under SSR and in headless tests.',
    )
    return inertApi(container)
  }

  const scope = `fx-ui-${++scopeCounter}`
  const root = el('div', { class: 'fx-ui', attrs: { 'data-fx-ui': scope } })

  const style = document.createElement('style')
  style.setAttribute('data-fx-ui-style', scope)
  style.textContent = stylesheet(scope)
  document.head.appendChild(style)
  ctx.disposables.addFn(() => style.remove())

  // The tokens are inherited from the map container when the root is inside it —
  // the usual case. They are re-declared on the root anyway, so that a product
  // mounting the chrome into its own app shell still gets the map's palette rather
  // than a browser default. See tokens.ts.
  applyTokens(root, ctx.theme.current.tokens)
  ctx.disposables.add(ctx.theme.onChange((theme) => applyTokens(root, theme.tokens)))

  const corners = new Map<MountSlot, HTMLElement>()
  for (const position of POSITIONS) {
    const corner = el('div', { class: `fx-ui-corner fx-ui-corner-${position}` })
    corners.set(position, corner)
    root.appendChild(corner)
  }
  const overlay = el('div', { class: 'fx-ui-overlay' })
  corners.set('overlay', overlay)
  root.appendChild(overlay)

  const status = el('div', {
    class: 'fx-ui-status',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-label': 'status' },
  })
  root.appendChild(status)

  container.appendChild(root)
  ctx.disposables.addFn(() => root.remove())

  const pointer = new InteractionPointerFeed()
  ctx.disposables.add(pointer.install(ctx.interaction))

  const toolbarModel = new SharedToolbarModel(ctx)
  ctx.disposables.add(toolbarModel.disposables)

  const statusEntries = new Map<string, HTMLElement>()

  const api: UiApi = {
    root,

    addControl(control: Control, position?: ControlPosition): Disposable {
      return mount(control, position ?? DEFAULT_SLOT[control.id] ?? 'top-left')
    },

    toolbar: {
      addButton: (button: ToolbarButton) => toolbarModel.addButton(button),
      setActive: (id: string | null) => toolbarModel.setActive(id),
    },

    status: {
      set(key: string, text: string): void {
        let entry = statusEntries.get(key)
        if (!entry) {
          entry = el('span', { class: 'fx-ui-status-entry' })
          entry.dataset['fxKey'] = key
          statusEntries.set(key, entry)
          status.appendChild(entry)
        }
        entry.textContent = text
      },
      clear(key: string): void {
        statusEntries.get(key)?.remove()
        statusEntries.delete(key)
      },
    },
  }

  function mount(control: Control, slot: MountSlot): Disposable {
    const parent = corners.get(slot)
    if (!parent) {
      throw new Error(
        `[fleximap/ui] unknown control position "${slot}" for control "${control.id}". ` +
          `Use one of: ${POSITIONS.join(', ')}.`,
      )
    }

    // A store per control, itself registered with the plugin's. Removing one
    // control tears down only its listeners; destroying the plugin tears down all
    // of them (invariant 5), and neither path leaves the other holding a stale
    // subscription.
    const disposables = new DisposableStore()
    const controlCtx: ControlContext = { ...ctx, disposables, ui: api, pointer, root, toolbarModel }

    const element = control.render(controlCtx)
    parent.appendChild(element)

    const disposable: Disposable = {
      dispose: () => {
        element.remove()
        control.destroy?.()
        disposables.dispose()
      },
    }
    return ctx.disposables.add(disposable)
  }

  for (const spec of ctx.options.controls ?? defaultControls(ctx.options)) {
    const [control, position] = Array.isArray(spec)
      ? (spec as readonly [Control, ControlPosition])
      : [spec as Control, undefined]
    mount(control, position ?? DEFAULT_SLOT[control.id] ?? 'top-left')
  }

  return api
}

/**
 * The default chrome.
 *
 * Everything that degrades to nothing when its plugin is absent is in here, which
 * is why the list is safe to ship as a default: with a bare kernel you get a
 * toolbar, a coordinate readout, a scale bar and an attribution line, and the rest
 * render hidden, listening to nothing.
 */
function defaultControls(options: ResolvedUiOptions): readonly ControlSpec[] {
  return [
    toolbarControl(),
    historyButtonsControl(),
    measureReadoutControl(),
    issuePanelControl(),
    coordinateReadoutControl(),
    scaleBarControl(),
    attributionControl({ attributions: options.attributions }),
    snapIndicatorControl(),
  ]
}

/* ========================================================================= */
/* The container                                                             */
/* ========================================================================= */

/**
 * Find something to mount into.
 *
 * `PluginContext` does not expose the map's container — it exposes the renderer,
 * the store, the buses, and everything else a plugin could want, but not the
 * element the map was mounted into. So we ask the renderer for its native handle
 * and read the container off it: MapLibre answers `getContainer()`, and the test
 * harness's `FakeRenderer` carries a `container` field. Both are duck-typed,
 * because the alternative is `import type { Map } from 'maplibre-gl'` in a package
 * that must also work under a Three.js renderer.
 *
 * A `container` on `PluginContext` would make this three lines shorter and exact —
 * it is the one thing in the kernel's plugin surface this package had to work
 * around.
 */
function resolveContainer(ctx: PluginContext<ResolvedUiOptions>): HTMLElement {
  const explicit = ctx.options.container
  if (explicit) return explicit

  const native = tryNative(ctx)

  const fromMethod = (native as { getContainer?: () => unknown } | undefined)?.getContainer
  if (typeof fromMethod === 'function') {
    const element = fromMethod.call(native)
    if (isElementLike(element)) return element
  }

  const fromField = (native as { container?: unknown } | undefined)?.container
  if (isElementLike(fromField)) return fromField

  throw new Error(
    `[fleximap/ui] could not find the map container. The renderer "${ctx.renderer.kind}" exposes ` +
      `neither getContainer() nor a container field on getNative(). Pass one explicitly: ` +
      `uiPlugin({ container: document.querySelector('#map') }).`,
  )
}

function tryNative(ctx: PluginContext<ResolvedUiOptions>): unknown {
  try {
    return ctx.renderer.getNative<unknown>()
  } catch {
    // A renderer that throws before it is mounted is behaving correctly; it just
    // cannot help us. The error above tells the user what to do about it.
    return undefined
  }
}

function isElementLike(value: unknown): value is HTMLElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { appendChild?: unknown }).appendChild === 'function'
  )
}

/** The no-DOM API: present, typed, and does nothing. */
function inertApi(root: HTMLElement): UiApi {
  const noop: Disposable = { dispose: () => {} }
  return {
    root,
    addControl: () => noop,
    toolbar: { addButton: () => noop, setActive: () => {} },
    status: { set: () => {}, clear: () => {} },
  }
}
