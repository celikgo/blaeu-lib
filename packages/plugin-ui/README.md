# @fleximap/plugin-ui

Framework-free map chrome for FlexiMap: a toolbar, a coordinate readout, a snap
indicator, undo/redo, an issue panel, a measurement readout, a scale bar and an
attribution line.

**Vanilla DOM and CSS custom properties. No React, no Vue.** That is a decision,
not an omission: this is a library, and picking a framework at the UI layer halves
its addressable audience on the day it ships. A React wrapper is a separate package
on the roadmap, and it is a thin one — a `useEffect` around `addControl`.

```bash
npm install @fleximap/plugin-ui
```

## Usage

```ts
import { createFlexiMap } from '@fleximap/core'
import { uiPlugin } from '@fleximap/plugin-ui'

const map = await createFlexiMap({
  container: '#map',
  plugins: [drawPlugin(), snapPlugin(), uiPlugin({ attributions: ['© OpenStreetMap'] })],
})

// Typed with no cast — the plugin augments FlexiPluginRegistry.
const ui = map.plugin('ui')
ui.status.set('hint', 'Click to place the first vertex')
```

Take only the controls you want, and everything else tree-shakes away:

```ts
import { uiPlugin, toolbarControl, coordinateReadoutControl } from '@fleximap/plugin-ui'

uiPlugin({ controls: [toolbarControl(), [coordinateReadoutControl(), 'bottom-right']] })
```

## What it registers

| Thing                                                                | Where                              |
| -------------------------------------------------------------------- | ---------------------------------- |
| `ui` in `FlexiPluginRegistry`                                        | `map.plugin('ui') → UiApi`         |
| One interaction middleware, `ui:pointer-feed` (priority −1000)       | reads the cursor _after_ snapping  |
| Message bundles `en` / `tr` under the `ui.*` and `snap.kind.*` keys  | disable with `{ messages: false }` |
| A `<style>` element in `document.head`, scoped to this map's UI root | removed on teardown                |

It registers **no tools, no layers, no commands, no validation rules, and it emits
no events.** It mutates nothing, so there is nothing for it to undo — the undo
round-trip test asserts exactly that.

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

## Accessibility

- `role="toolbar"` with a **roving tabindex**: one tab stop for the group, arrow
  keys to move within it, Home/End to jump. Tab is never swallowed.
- `aria-pressed` on the active tool's button — and only on buttons that are
  genuinely toggles.
- `aria-label` on every control and every button, from i18n.
- A visible focus ring on everything focusable (`:focus-visible`, in the accent
  colour).
- The status line and the issue list are polite live regions. The coordinate
  readout is polite too, never assertive: it updates at pointer frequency, and an
  assertive region would make a screen reader talk over everything else for as long
  as the mouse is moving.

## Theming

Every colour, radius, font and stacking order is a `var(--fx-*)` written by the
core's `ThemeManager`. Nothing in this package hardcodes a palette, and no element
carries an inline style for anything themeable — so the selected row in the issue
panel is the _same_ blue as the selection halo on the map, because both read the
same token.

```ts
map.theme.set({ tokens: { color: { accent: '#c026d3' } } }) // the whole UI follows
```

The two exceptions are the snap indicator's `--fx-ui-x` / `--fx-ui-y` and the scale
bar's width. Those are the cursor's position and a measured distance: data, not
design.

By default the UI mounts into the map container, where the theme's custom
properties already live. Mount it elsewhere with `uiPlugin({ container })` and the
tokens are mirrored onto the root, so the palette still matches.

## Known friction with the core

- `PluginContext` does not expose the map's container. The plugin duck-types it out
  of `renderer.getNative()` (MapLibre answers `getContainer()`; the test harness's
  `FakeRenderer` carries a `container` field). A `container` on `PluginContext`
  would make this exact rather than inferred.
- `ToolManager` emits no `tool:registered` event, so the toolbar re-derives its
  buttons on `plugin:registered` / `plugin:removed` / `map:ready` instead of on the
  registration itself. That covers every real case (plugins register their tools in
  `setup`), but a tool registered lazily, long after its plugin installed, will not
  appear until the next such event.
