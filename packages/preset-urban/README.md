# @blaeu/preset-urban

The BlaeuMap kernel, as an **urban planning** tool: a zoning legend that styles itself, a 5 m planning
grid, forgiving snapping, warning-level topology, deep undo, and scenario comparison.

```ts
import { createBlaeuMap } from '@blaeu/core'
import { urbanPlanningPreset } from '@blaeu/preset-urban'

const map = await createBlaeuMap({
  container: '#map',
  preset: urbanPlanningPreset({ crs: 'EPSG:5254', locale: 'tr' }),
})

const scenarios = map.plugin('scenario')
scenarios.create('Mevcut')
// …the planner re-zones two blocks…
scenarios.create('Yoğun')

console.table(scenarios.compare('Mevcut', 'Yoğun').categories)
// code  label            areaA     areaB     deltaM2   deltaPercent
// K     Konut Alanı      12 400    18 900    +6 500    +52.4
// T     Ticaret Alanı     6 500         0    -6 500   -100.0
```

---

## Who this is for

A **planning department** drawing or revising an imar planı: allocating functions to blocks, testing
alternatives, and reporting how much land each function gained or lost.

Not a surveyor. If your output is a boundary that ends up on a title deed, you want
`@blaeu/preset-cadastre` — same kernel, same plugins, opposite judgement (see the table below, and
the comment above `validation` in [`src/preset.ts`](./src/preset.ts), which is the clearest statement in
this repo of what a preset is _for_).

## What it assumes

- **A projected working CRS, in metres.** Defaults to `EPSG:5254` (TUREF / TM33 — the 3° belt through
  Ankara). Every area, every grid step, every tolerance in this package is metres _on that plane_. Left
  at the kernel's `EPSG:3857` default, areas at Turkish latitudes come out ~70 % too large and look
  entirely plausible while doing so. Set your belt.
- **Zoning polygons live in one collection** (`zoning` by default) and carry their category on one
  property (`zoning` by default).
- **The legend is data.** Five Turkish defaults ship (konut, ticaret, sanayi, yeşil alan, donatı); pass
  your own and the fill colours, the attribute forms and the scenario report all follow.
- **Turkish by default**, with `en` shipped alongside.

## The judgement, in one table

The row that matters is the last one. Cadastre and urban install **the same topology plugin**; only the
severity differs, and it differs _in the preset_, in one line, because only a preset knows the domain.

|                       | `preset-cadastre`     | `preset-urban`           | why                                                                                                                                       |
| --------------------- | --------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Snap tolerance        | 12 px                 | **20 px**                | A planner is sketching a proposal, not reproducing a boundary that legally exists                                                         |
| Grid snapping         | off                   | **on, 5 m**              | A plan drawn on a module subdivides into buildable plots; cadastre rounding _is_ the error                                                |
| Coordinate precision  | 3 (mm)                | **2 (cm)**               | A plan boundary quoted to the millimetre claims precision the plan does not have                                                          |
| Undo depth            | 200                   | **500**                  | Planners explore, and back out further                                                                                                    |
| Area unit             | dönüm / m²            | **hectares**             | The unit a plan is read in                                                                                                                |
| **Overlaps and gaps** | **`error`** — blocked | **`warning`** — reported | An overlap is a _dispute_ in cadastre and a _thought_ in planning. A tool that refuses the intermediate state is a tool that gets closed. |

Structural defects — unclosed ring, duplicate vertex, self-intersection — stay `error` even here: a
bowtie has no well-defined area, and the area is the number the scenario report hands to a council.

---

## Options

Every one of these is a knob a planning department would argue about. If you find yourself wanting to
copy `preset.ts` to change a number, that number is a bug in this table — open an issue.

| Option               | Type                | Default                     | What it is                                                               |
| -------------------- | ------------------- | --------------------------- | ------------------------------------------------------------------------ |
| `crs`                | `CrsCode`           | `'EPSG:5254'`               | Projected working CRS. All maths is metres on this plane.                |
| `locale`             | `Locale`            | `'tr'`                      |                                                                          |
| `zoningCategories`   | `ZoningCategory[]`  | `DEFAULT_ZONING_CATEGORIES` | The legend. Drives fill colours, forms and the scenario report.          |
| `scenarios`          | `boolean`           | `true`                      | Install the scenario plugin.                                             |
| `zoningCollection`   | `CollectionId`      | `'zoning'`                  | Where zoning polygons live.                                              |
| `zoningProperty`     | `string`            | `'zoning'`                  | Property carrying the category code.                                     |
| `defaultCategory`    | `string`            | first category              | Stamped on every newly drawn polygon. Must exist in the legend.          |
| `fillOpacity`        | `number` (0–1)      | `0.55`                      | Zoning fill opacity.                                                     |
| `snapTolerance`      | `number` (px)       | `20`                        | How close is "close".                                                    |
| `gridSize`           | `number` (m)        | `5`                         | The planning grid. `0` disables grid snapping.                           |
| `undoDepth`          | `number`            | `500`                       | Undo steps kept.                                                         |
| `topologySeverity`   | `Severity`          | `'warning'`                 | Overlap, gap, sliver, undersized zone.                                   |
| `structuralSeverity` | `Severity`          | `'error'`                   | Unclosed ring, duplicate vertex, self-intersection.                      |
| `minZoneArea`        | `number` (m²)       | `100`                       | Below this a zone is a digitising slip.                                  |
| `areaUnit`           | `'ha' \| 'm2' \| …` | `'ha'`                      | `'m2'` for a 1/1000 uygulama planı.                                      |
| `lengthUnit`         | `'m' \| 'km'`       | `'m'`                       |                                                                          |
| `precision`          | `number`            | `2`                         | Readout decimals. Also derives the topology tolerance (`10^-precision`). |
| `topologicalEditing` | `boolean`           | `true`                      | A corner shared by two zones moves in both.                              |
| `attributeSchema`    | `AttributeSchemas`  | derived from the legend     | Replace the forms wholesale. Rarely what you want — see below.           |

### `ZoningCategory`

```ts
{ code: 'K', label: 'Konut Alanı', color: '#f6c244', maxFar: 1.5, maxCoverage: 0.4, maxHeight: 15.5 }
```

`maxFar` (KAKS / emsal), `maxCoverage` (TAKS) and `maxHeight` (gabari) are the caps the plan sets. They
flow one way — category → the `max` on the attribute field → the number the form can enforce — so a form
can never let a planner type a KAKS the plan forbids. Omit a cap and the field is uncapped, which is the
honest thing for yeşil alan: what is buildable in a park is decided case by case, and inventing a KAKS
for it would put a number the plan never wrote into a form a planner will believe.

---

## How to override it — without forking

`urbanPlanningPreset()` returns **plain data**. Nothing is constructed, no map is touched, no global is
written. That is what makes all of the below work.

### 1. Retune a number → pass an option

```ts
urbanPlanningPreset({ gridSize: 2.5, snapTolerance: 12, areaUnit: 'm2' })
```

### 2. Retune a _plugin's_ option → `composePresets`, and do not re-declare the plugin

This is the important one. İzmir digitises at 1/1000, where a 20 px snap is a whole building. They say so
in six lines and inherit everything else — the provider list, the 5 m grid, the whole validation set —
without restating any of it:

```ts
import { composePresets, definePreset, createBlaeuMap } from '@blaeu/core'
import { snapPlugin } from '@blaeu/plugin-snap'
import { urbanPlanningPreset } from '@blaeu/preset-urban'

const izmir = composePresets(
  urbanPlanningPreset(), // national base
  definePreset({
    id: 'izmir',
    plugins: [[snapPlugin, { tolerance: 8 }]], // retuned, not re-declared
    config: { crs: { working: 'EPSG:5253' } }, // İzmir's belt (TUREF/TM27); deep-merged: precision/display survive
    layers: [{ id: 'kentsel-donusum', type: 'vector', source: 'donusum' }], // appended
    validation: [planNotuRequired({ severity: 'warning' })], // appended
    i18n: { tr: { 'urban.zoning.K': 'Konut (İZBB)' } }, // merged per key
  }),
)

const map = await createBlaeuMap({ container: '#map', preset: izmir })
```

Merge semantics, worth knowing by heart:

- `config`, `theme` → **deep merge**, later wins.
- `plugins` → **append**, but a repeated plugin id **deep-merges its options into the existing entry, in
  place**. `{ tolerance: 8 }` above keeps `gridSize: 5` and the provider list, and keeps snap's install
  position.
- `validation`, `layers`, `interactionMiddleware`, `commitMiddleware` → **append**.
- `i18n` → merge per locale, later wins per key.

### 3. Throw something away → `overridePreset`

Append cannot express "no rules at all". A demo environment that must not enforce anything:

```ts
overridePreset(urbanPlanningPreset(), { validation: [] })
```

Needing this often is a smell — the knob should have been an option here instead. Tell us.

### 4. Change the legend → pass it

```ts
urbanPlanningPreset({
  zoningCategories: [
    ...DEFAULT_ZONING_CATEGORIES,
    { code: 'TUR', label: 'Turizm Tesis Alanı', color: '#f472b6', maxFar: 0.6, maxHeight: 12 },
  ],
})
```

One new object gets you: a colour in the fill expression, an attribute form with the right caps, a
dropdown option in every other category's form, and a row in every scenario comparison. No new layer, no
new rule, no code.

---

## The zoning layer: one layer, N categories

The fill colour is a MapLibre `match` expression built from the legend:

```
['match', ['get', 'zoning'], 'K', '#f6c244', 'T', '#e4572e', 'S', '#8e5ba6', …, '#b8b8b8']
```

The obvious alternative — one layer per category with a filter — is what most codebases do, and it costs
you a source read, a draw call and a z-order _per category_, a z-fight where two categories touch, and,
worst, a new layer to register every time the legend grows. That last one puts the legend back in code.
Here it stays data: `zoningCategories` in, expression out. Build one yourself with
`zoningFillColour(categories, property)`.

The trailing fallback is mandatory in `match`, and it earns its keep: a polygon imported from a plan
whose code you don't know renders grey rather than not at all.

## Attribute forms

Derived from the legend by `zoningAttributeSchema(categories)`, and shipped **inside the preset value**
on the zoning layer's `config`, so a host app can render a form without ever constructing a map:

```ts
const preset = urbanPlanningPreset()
const schema = preset.layers?.[0]?.config?.attributes // { K: { fields: [...] }, T: …, … }
```

Fields: `zoning` (select, every category), `kaks`, `taks`, `gabari` (numbers, capped by the category),
`planNotu` (text — a plan note is legally binding, so it is a field, not a "description").

## Scenarios

A scenario is a **named store snapshot**. The API is a tiny plugin that ships _with this preset_ — which
is itself the point: "compare two versions of the plan by zoning category" is not a capability the kernel
lacks, it is judgement about what a planner does all day, so it lives where the domain lives.

```ts
const s = map.plugin('scenario') // typed, no cast

s.create('Mevcut') // snapshot the store under a name, and make it active
s.switch('Yoğun') // checks the current work into the active scenario first, then restores
s.save() // re-snapshot into the active scenario
s.areas('Mevcut') // [{ code, label, areaM2 }, …] — planar m², legend order
s.compare('Mevcut', 'Yoğun')
// { a, b, totalA, totalB, categories: [{ code, label, areaA, areaB, deltaM2, deltaPercent }] }
```

Two details that are not accidents:

- **Switching is a `Command`.** It goes through the command bus, so Ctrl-Z takes you back (core
  invariant 2). A scenario switch that silently swapped the store would leave undo with nothing to undo
  and a history panel showing nothing while the map changed underneath it.
- **`deltaPercent` is `null`, not `Infinity`,** when a category was absent from `a`. A category that goes
  from nothing to eight hectares has not grown by a percentage; it has appeared. A report that prints
  "+∞ %" — or worse, "+100 %" — is one a planner misreads once and distrusts forever.

Turn the whole thing off with `scenarios: false`, or install it standalone: `scenarioPlugin({ collection })`
depends on nothing but the kernel.

## i18n

`tr` and `en` ship, with the vocabulary a planning office actually uses: _imar_, _ada_, _KAKS/emsal_,
_TAKS_, _gabari_, _plan notu_. Override any key by composing (§2 above) — a preset's messages win over a
plugin's, and a later preset's win over an earlier one's.

## Layers, collections and ids

| id               | type     | source   | notes                                                  |
| ---------------- | -------- | -------- | ------------------------------------------------------ |
| `zoning-fill`    | `vector` | `zoning` | `match`-expression fill; carries the forms in `config` |
| `zoning-outline` | `vector` | `zoning` | Same source, ref-counted — one upload, not two         |

## Installed plugins

`snap`, `select`, `draw`, `edit`, `measure`, `topology`, `history`, `scenario` — in that order.
