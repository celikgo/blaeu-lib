# Theming

A Blaeu theme is a set of design tokens plus an optional basemap and CSS. It feeds
**two** consumers from one source: the UI chrome (as CSS custom properties, e.g.
`--bl-color-accent`) and the map itself (as the values inside MapLibre paint
expressions, read by plugins through `map.theme.token('color')`). That single source
is why the selection halo on the map is exactly the same colour as the selected row
in the attribute table — they read the same number, not two files that happen to
agree today.

A theme reaches the **whole map**: the basemap ground, the on-map feature layers, the
edit handles, the snap indicator, the selection halo, the measurement labels, and the
toolbar chrome. Switching a theme at runtime repaints all of it, live, without losing
a single feature.

## Switching themes

Seven themes are registered on every map, so you can switch by id with no setup:

```ts
map.theme.use('twitter-dim') // night
map.theme.use('twitter-light') // day
map.theme.list() //  → every registered theme, for building a picker
map.theme.has('imagery-dark') // → true
map.theme.current.id // the active theme
map.theme.scheme // 'light' | 'dark'
```

`use()` of an unknown id throws (with the list of valid ids) rather than silently
leaving a blank map.

A **preset's** theme is applied, not registered: `preset.theme` goes through
`theme.set()`, which merges into the active theme without touching the registry. So
the cadastre preset's theme is what you are looking at, but it does not appear in
`list()` and `use('cadastre')` throws. If you want to switch away from a preset theme
and back again, call `map.theme.register(preset.theme)` yourself first.

### Following the OS

```ts
map.theme.follow('auto') // track prefers-color-scheme, and flip live when the OS does
map.theme.follow('light') // pin light
map.theme.follow('dark') // pin dark
```

In `'auto'`, the map switches between the two themes named by `setSchemeDefaults`
(default: `twitter-light` / `twitter-dim`) whenever the OS setting changes — at
sunset, say. An explicit `map.theme.use(id)` afterwards takes back manual control and
sticks until you call `follow('auto')` again.

```ts
map.theme.setSchemeDefaults({ light: 'survey-paper', dark: 'imagery-dark' })
```

## The built-in themes

| id              | scheme | notes                                                                                   |
| --------------- | ------ | --------------------------------------------------------------------------------------- |
| `blaeu-default` | light  | the neutral slate/blue chrome every map starts on, until a preset or `use()` changes it |
| `twitter-light` | light  | X's default day palette                                                                 |
| `twitter-dim`   | dark   | X's Dim night palette                                                                   |
| `twitter-black` | dark   | X's Lights-out — true black, for OLED                                                   |
| `survey-paper`  | light  | warm cadastral survey sheet; low-contrast so the boundary wins                          |
| `high-contrast` | light  | WCAG **AAA**; for a laptop in direct sunlight                                           |
| `imagery-dark`  | dark   | night theme tuned to sit over satellite / orthophoto tiles                              |

All seven are audited against WCAG, and the audit is generated:
[docs/contrast.md](contrast.md) lists every pair the shipped code actually paints — 20 of
them per theme — with the file and line that paints it, the floor it answers to, and the
measured ratio. `packages/core/src/theme/contrast.test.ts` recomputes the lot, asserts the
floors, and regenerates that document; a re-tinted token whose number does not reach the
document fails the build. It also reads the `// 4.67:1` annotations back out of the theme
sources and checks those, which is how the one wrong number among them was found.

The rules come from call sites, not from token names, and that is the whole design. A
blanket 4.5:1 would call `accent` a defect at 3.00:1 on white — when the vivid blue is kept
deliberately, because it is a mark on a map and 3:1 is the floor for a graphic. It would
also wave through `hover`, which nothing in the name suggests is the background of a
control that keeps `color: inherit`, and which is where most of the current failures are.

The Twitter palettes correct three of X's own contrast failures while keeping the hue:
white-on-blue is exactly 3.00:1, so a filled button uses `accentStrong`/`onAccent` instead;
X's snap-yellow is 1.43:1 on white, so the light theme's snap indicator is deepened to
5.18:1; Lights-out muted text is nudged from X's 3.88:1 to clear 4.5:1. Each of the three
is a named test rather than a sentence.

Thirty-six pairs are currently below their floor, and they are published rather than
waived — pinned to the exact ratio they have, so the number cannot move unnoticed in either
direction. Twenty-nine of the thirty-six share one background, `hover`, which is a single
design decision rather than twenty-nine mistakes.
The three preset themes are not audited at all; see the end of
[docs/contrast.md](contrast.md).

## Tokens

`ThemeTokens` groups the values a theme sets. Colours:

| token                                | what it is                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `accent`, `accentMuted`              | the brand colour, and a muted form; the accent doubles as a map mark                         |
| `accentStrong`, `onAccent`           | a filled control: a stronger accent and the label colour that sits on it                     |
| `selection`, `hover`                 | selection halo and hover highlight                                                           |
| `vertex`, `vertexActive`, `midpoint` | edit-handle fills                                                                            |
| `snapIndicator`                      | the snap ring and its tooltip                                                                |
| `guide`                              | construction / alignment guides                                                              |
| `error`, `warning`, `success`        | semantic status                                                                              |
| `canvas`                             | **the map ground** — the colour a flat basemap paints, distinct from the panels              |
| `surface`, `surfaceMuted`            | panel / chrome backgrounds                                                                   |
| `text`, `textMuted`                  | chrome text                                                                                  |
| `labelHalo`                          | the halo around **on-map** labels — the colour of the ground, so a dark map gets a dark halo |
| `border`                             | chrome borders                                                                               |

There are also `size`, `font`, and `z` groups. `token(group)` hands plugins a whole
group of raw values — `map.theme.token('size').vertexRadius` is `5`, ready to drop into
a MapLibre paint expression; the CSS variable `--bl-size-vertex-radius` carries the unit
(`5px`). The `z` group is unitless in CSS too.

## Theme-following layer styles

A declarative layer can follow the theme by giving its `style` as a function of the
tokens instead of a fixed value. The layer manager resolves it against the live tokens
and re-resolves on every theme change:

```ts
import type { BlaeuMap } from '@blaeu/core'

declare const map: BlaeuMap

map.layers.add({
  id: 'parcels',
  type: 'vector',
  source: 'parcels',
  style: (t) => ({
    line: { color: t.color.accent },
    fill: { color: t.color.accent, opacity: 0.08 },
  }),
})
```

Switch to a dark theme and the parcel line re-tints with everything else — no
subscription in the caller. A manual `layer.setStyle(...)` afterwards wins and detaches
the layer from the theme.

## The basemap

`Theme.basemap` is a MapLibre style (URL or JSON). Switching a theme applies it to the
renderer at runtime. MapLibre's `setStyle()` tears down every source and layer, so
Blaeu re-materialises the ones it created — with their data and stacking order — after
the new style loads. The camera does not move.

The built-in themes ship a **flat, offline** basemap: a `background` layer painted the
theme's `canvas` colour, nothing fetched over the network. That is what makes
`use('twitter-dim')` turn the ground dark. An app with its own tiles registers a
variant whose `basemap` is its own style:

```ts
import { twitterDim } from '@blaeu/core'
import type { BlaeuMap } from '@blaeu/core'

declare const map: BlaeuMap

map.theme.register({
  ...twitterDim,
  id: 'twitter-dim-osm',
  basemap: { version: 8, sources: { osm: {/* … */} }, layers: [/* … */] },
})
```

In a merge/patch, `basemap: null` **clears** a previous theme's basemap; `undefined`
leaves it. A flat basemap has no `glyphs` endpoint, so on-map _text_ layers (parcel
labels) need a basemap that provides one, or the labels render blank.

## Writing your own theme

The easiest way is `buildTheme`, which fills in every token from the default, paints
the flat basemap from your `canvas`, and returns a complete, self-consistent theme:

```ts
import { buildTheme } from '@blaeu/core'
import type { BlaeuMap } from '@blaeu/core'

declare const map: BlaeuMap

const brand = buildTheme({
  id: 'acme',
  scheme: 'light',
  color: {
    canvas: '#ffffff',
    accent: '#7c3aed',
    accentStrong: '#5b21b6',
    onAccent: '#ffffff',
    selection: '#db2777',
    // …only the tokens you care about; the rest inherit the default
  },
})

map.theme.register(brand)
map.theme.use('acme')
```

Validate the pairs you set against WCAG: body text on `surface` ≥ 4.5:1, `onAccent`
on `accentStrong` ≥ 4.5:1, and every on-map mark (`selection`, `snapIndicator`,
`accent`) ≥ 3:1 on `canvas`. The generated audit covers the seven built-ins only, so a
theme you register in your own app is not gated by it — [docs/contrast.md](contrast.md)
is the list of pairs worth checking, and the reasoning for each.
