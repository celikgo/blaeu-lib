# @blaeu/plugin-ui

Framework-free map chrome for Blaeu: a toolbar, a coordinate readout, a snap
indicator, undo/redo, an issue panel, a measurement readout, a scale bar and an
attribution line.

**Vanilla DOM and CSS custom properties. No React, no Vue.** That is a decision,
not an omission: this is a library, and picking a framework at the UI layer halves
its addressable audience on the day it ships. A React wrapper is a separate package
on the roadmap, and it is a thin one — a `useEffect` around `addControl`.

```bash
npm install @blaeu/plugin-ui
```

> Not on npm yet — see [the root README](../../README.md#packages) for how to run it from source.

## Usage

```ts
import { createBlaeuMap } from '@blaeu/core'
import { uiPlugin } from '@blaeu/plugin-ui'
import { drawPlugin } from '@blaeu/plugin-draw'
import { snapPlugin } from '@blaeu/plugin-snap'

const map = await createBlaeuMap({
  container: '#map',
  plugins: [drawPlugin(), snapPlugin(), uiPlugin({ attributions: ['© OpenStreetMap'] })],
})

// Typed with no cast — the plugin augments BlaeuPluginRegistry.
const ui = map.plugin('ui')
ui.status.set('hint', 'Click to place the first vertex')
```

Take only the controls you want, and everything else tree-shakes away:

```ts
import { uiPlugin, toolbarControl, coordinateReadoutControl } from '@blaeu/plugin-ui'

uiPlugin({ controls: [toolbarControl(), [coordinateReadoutControl(), 'bottom-right']] })
```

Each control carries its own id and its own default corner, so the list above is a
list of _what_, not of _where_. Pin one somewhere else by pairing it with a
position, as `coordinateReadoutControl()` is above; an id the plugin does not
recognise falls back to `top-left`.

| Factory                      | Control id       | Default corner | Options                                     |
| ---------------------------- | ---------------- | -------------- | ------------------------------------------- |
| `toolbarControl()`           | `toolbar`        | top-left       | —                                           |
| `historyButtonsControl()`    | `history`        | top-left       | —                                           |
| `measureReadoutControl()`    | `measure`        | top-right      | —                                           |
| `issuePanelControl()`        | `issues`         | top-right      | —                                           |
| `coordinateReadoutControl()` | `coordinates`    | bottom-left    | —                                           |
| `scaleBarControl()`          | `scale`          | bottom-left    | `maxWidthPx` (110)                          |
| `attributionControl()`       | `attribution`    | bottom-right   | `attributions`, `separator` (a spaced pipe) |
| `snapIndicatorControl()`     | `snap-indicator` | the overlay    | —                                           |

The snap indicator is the one that is not in a corner: it anchors to the cursor, so
it mounts on a full-bleed, pointer-transparent overlay layer instead. That is why
`MountSlot` is wider than `ControlPosition` — a user choosing a position should be
choosing between four corners, not between four corners and a special case.

## What it registers

| Thing                                                                | Where                              |
| -------------------------------------------------------------------- | ---------------------------------- |
| `ui` in `BlaeuPluginRegistry`                                        | `map.plugin('ui') → UiApi`         |
| One interaction middleware, `ui:pointer-feed` (priority −1000)       | reads the cursor _after_ snapping  |
| Message bundles `en` / `tr` under the `ui.*` and `snap.kind.*` keys  | disable with `{ messages: false }` |
| A `<style>` element in `document.head`, scoped to this map's UI root | removed on teardown                |

The message bundles are also exported directly, as `uiMessagesEn` / `uiMessagesTr`,
so a preset can extend them rather than restate them.

It registers **no tools, no layers, no commands, no validation rules, and it emits
no events.** It mutates nothing, so there is nothing for it to undo — the undo
round-trip test asserts exactly that.

With no `document` — SSR, or the node suite, which is where most of this monorepo's
tests run — the plugin installs and its API is present but inert: nothing is
mounted, nothing throws, and `map.plugin('ui')` still resolves. A preset that
bundles the chrome is therefore installable in exactly the environments that
legitimately have no screen.

## Dependencies

Everything is **optional**, and each one degrades to nothing:

| Plugin     | Without it                                                             |
| ---------- | ---------------------------------------------------------------------- |
| `snap`     | the snap indicator stays hidden; nothing else changes                  |
| `history`  | the undo/redo group hides itself, rather than showing two dead buttons |
| `topology` | the issue panel still shows core `validation:failed` issues            |
| `measure`  | the measurement readout stays hidden                                   |

Presence is checked **live**, not once at setup. Install a history plugin at
runtime and the undo buttons appear; remove it and they go away. This is not
gold-plating — the kernel installs a preset's plugins concurrently
(`Promise.all`), and an optional dependency is deliberately _not_ awaited, so
"is `history` installed?" asked inside `setup()` is a microtask race with no right
answer.

None of the optional plugins is imported, at type level or otherwise. The UI reads
`InteractionContext.snap` (the core's own contract) for snapping, and reads the
`snap:*` / `history:*` / `topology:*` / `measure:*` event payloads structurally.
An optional dependency you have to import is not optional.

## Events

**Consumed:** `tool:activated`, `tool:deactivated`, `plugin:registered`,
`plugin:removed`, `map:ready`, `camera:move`, `camera:idle`, `command:executed`,
`command:undone`, `command:redone`, `validation:failed`, `feature:updated`, and —
structurally, if the plugin that emits them is installed — `snap:*`, `history:*`,
`topology:*`, `measure:*`.

**Emitted:** none.

## The toolbar builds itself

Buttons are derived from `tools.list()`, so a tool registered by **any** plugin —
including one written later by someone who has never read this package — appears
in the toolbar with no code here:

```ts
ctx.tools.register('cadastre:split-parcel', splitTool())
// → a button, an aria-pressed that tracks activation, and a label from
//   i18n key `tool.cadastre:split-parcel`.
```

Labels come from i18n, which is how the cadastre preset renames "Polygon" to
"Parsel çiz" without this package containing a word of Turkish:

```ts
preset.i18n = { tr: { 'tool.draw:polygon': 'Parsel çiz' } }
```

A missing translation falls back to the tool id, never to the raw i18n key.

## Write your own control

`Control` is the whole extension point, and it is deliberately small: an id, a
`render` that returns one element, and an optional `destroy` for exotic cleanup.
The plugin owns where the element goes and when it dies, so a control never has to
know about corners, teardown order, or the other controls.

```ts
import { createBlaeuMap } from '@blaeu/core'
import type { Control, ControlContext } from '@blaeu/plugin-ui'
import { uiPlugin } from '@blaeu/plugin-ui'

const zoomBadge: Control = {
  id: 'zoom-badge',
  render(ctx: ControlContext): HTMLElement {
    const element = document.createElement('div')
    element.className = 'bl-ui-control bl-ui-readout bl-ui-readout-empty'
    element.textContent = '—'
    // A *control-scoped* store: this subscription dies with this control alone.
    ctx.disposables.add(
      ctx.events.on('camera:idle', ({ payload }) => {
        element.classList.remove('bl-ui-readout-empty')
        element.textContent = payload.zoom.toFixed(1)
      }),
    )
    return element
  },
}

const map = await createBlaeuMap({ container: '#map', plugins: [uiPlugin()] })
const remove = map.plugin('ui').addControl(zoomBadge, 'top-right')
// remove.dispose() takes away this control and nothing else.
```

`ctx` is the plugin context with three additions and one substitution:
`ctx.disposables` is scoped to **this control** rather than to the plugin, so
disposing the returned `Disposable` removes just this control and just its
listeners — while destroying the map still tears down every control, because each
store is registered with the plugin's own (core invariant 5). `ctx.ui` is the
plugin's API, so a control can write to the status line; `ctx.pointer` is the live
post-snap pointer feed; `ctx.root` is the UI root, for a control that needs to
measure against it; and `ctx.toolbarModel` is the toolbar's state, which lives on
the plugin rather than in the Toolbar control's closure so that
`ui.toolbar.addButton()` works before any toolbar is mounted.

Omit the position and the control lands on the default corner for its id — or
`top-left` for an id the plugin has never heard of, which is every id you invent.

## Accessibility

- `role="toolbar"` with a **roving tabindex**: one tab stop for the group, arrow
  keys to move within it, Home/End to jump. Tab is never swallowed.
- `aria-pressed` on the active tool's button — and only on buttons that are
  genuinely toggles.
- `aria-label` on every corner control and every button, from i18n — the snap
  indicator is named by its own text instead, since its content _is_ the label.
- A visible focus ring on everything focusable (`:focus-visible`, in the accent
  colour).
- The status line and the issue list are polite live regions. The coordinate
  readout is polite too, never assertive: it updates at pointer frequency, and an
  assertive region would make a screen reader talk over everything else for as long
  as the mouse is moving.

## Theming

Every colour, radius, font and stacking order is a `var(--bl-*)` written by the
core's `ThemeManager`. Nothing in this package hardcodes a palette, and no element
carries an inline style for anything themeable — so an error row's rule stripe is
the _same_ red as every other error in the product, because both read
`--bl-color-error`.

```ts
map.theme.set({ tokens: { color: { accent: '#c026d3' } } }) // the whole UI follows
```

The two exceptions are the snap indicator's `--bl-ui-x` / `--bl-ui-y` and the scale
bar's width. Those are the cursor's position and a measured distance: data, not
design. The one literal colour in the stylesheet is the control shadow
(`rgb(0 0 0 / 0.12)`), which is opacity rather than palette — it sits over whatever
`--bl-color-surface` happens to be.

By default the UI mounts into the map container, where the theme's custom
properties already live. The tokens are re-declared on the UI root in every case —
a no-op when it is inside the map container — so mounting the chrome into your own
app shell with `uiPlugin({ container })` still gets the map's palette rather than a
browser default.

## DOM contract

The stylesheet is scoped by attribute selector rather than by Shadow DOM. Shadow
DOM would isolate more completely, but it also walls the chrome off from the host
app's own stylesheet — and a product team's first request is always "make the
toolbar look like the rest of our app". So the class names below are a **supported
override surface**, not an implementation detail: style them, and the package will
not rename them under you.

Every rule is scoped to one map instance by the root's `data-bl-ui` attribute
(`bl-ui-1`, `bl-ui-2`, …), so two maps on a page cannot restyle each other, and so
a host app's own `.bl-ui-button` rule wins by simply not carrying the attribute in
its selector.

| Element                                                                     | Class                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| the root, one per map                                                       | `.bl-ui`, carrying `[data-bl-ui="bl-ui-N"]`                            |
| the four corner stacks                                                      | `.bl-ui-corner`, `.bl-ui-corner-top-left` … `-bottom-right`            |
| the cursor-anchored, pointer-transparent layer                              | `.bl-ui-overlay`                                                       |
| the status line, and one entry per key                                      | `.bl-ui-status`, `.bl-ui-status-entry` (`data-bl-key="<key>"`)         |
| anything that looks like a floating panel — surface, border, radius, shadow | `.bl-ui-control`                                                       |
| the toolbar and its buttons                                                 | `.bl-ui-toolbar`, `.bl-ui-button` (`data-bl-id="<tool or button id>"`) |
| a button's glyph and its text                                               | `.bl-ui-button-icon`, `.bl-ui-button-label`                            |
| a readout, and a readout showing its placeholder                            | `.bl-ui-readout`, `.bl-ui-readout-empty`                               |
| the coordinate and measurement readouts                                     | `.bl-ui-coordinates`, `.bl-ui-measure`                                 |
| the scale bar                                                               | `.bl-ui-scale`, `.bl-ui-scale-bar`, `.bl-ui-scale-label`               |
| the attribution line                                                        | `.bl-ui-attribution`                                                   |
| the snap indicator                                                          | `.bl-ui-snap`                                                          |
| the issue panel                                                             | `.bl-ui-issues`, `.bl-ui-issues-head`, `.bl-ui-issues-list`            |
| one issue row, by severity                                                  | `.bl-ui-issue`, `.bl-ui-issue-error` / `-warning` / `-info`            |

The two `data-*` attributes are load-bearing rather than decorative:
`data-bl-id` on a button is how you find _one_ tool's button without matching on a
translated label, and `data-bl-key` on a status entry is how you find the entry a
particular plugin wrote. This package's own tests select on both, which is the
honest reason to trust them.

## Known friction with the core

- `PluginContext` does not expose the map's container. The plugin duck-types it out
  of `renderer.getNative()` (MapLibre answers `getContainer()`; the test harness's
  `FakeRenderer` carries a `container` field). A `container` on `PluginContext`
  would make this exact rather than inferred.
- `ToolManager` emits no `tool:registered` event, so the toolbar re-derives its
  buttons on `plugin:registered` / `plugin:removed` / `map:ready`, and defensively
  on `tool:activated`, instead of on the registration itself. That covers every real
  case (plugins register their tools in `setup`), but a tool registered lazily, long
  after its plugin installed, will not appear until the next such event — activating
  it counts, since a tool cannot become active without existing.
