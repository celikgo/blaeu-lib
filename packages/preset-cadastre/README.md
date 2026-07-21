# @blaeu/preset-cadastre

The BlaeuMap kernel, aimed at a land registry.

```ts
import { createBlaeuMap } from '@blaeu/core'
import { cadastrePreset } from '@blaeu/preset-cadastre'

const map = await createBlaeuMap({
  container: '#map',
  preset: cadastrePreset({ crs: 'EPSG:5254', locale: 'tr' }),
})
```

That is the whole setup. You now have: a projected working plane with millimetre
readouts, polygon drawing that snaps to neighbouring parcel corners, **topological**
vertex editing, parcel-to-parcel topology validation with cadastral severities, a
`yuzolcumu` that is computed from the boundary rather than typed, an ada/parsel
attribute schema, a pale basemap so the boundaries dominate, and Turkish.

---

## Who this is for

Anyone digitising, editing or checking **parcel boundaries** — a Kadastro
Müdürlüğü, a municipality's imar/kadastro unit, a licensed survey office (LİHKAB),
or a firm building a product for one of them.

## What it assumes

- **Your working CRS is projected and metric.** The default is TUREF/TM30
  (EPSG:5254), the 3° belt centred on 30°E. Pick _your_ belt — 5253 (27°E), 5255
  (33°E), and so on. Getting the belt wrong is not a rounding error: a parcel
  measured 6° off its central meridian is wrong by metres.
- **Area is planar, and derived.** Never spherical, never typed. See below.
- **Parcels and buildings are different things.** Buildings are context; parcels
  are the document. Selection, the relational topology rules, and the attribute
  rule all apply to parcels only.
- **A shared boundary is one boundary.** `edit` runs with `topological: true`, and
  that is not an option this preset exposes. A system that lets two adjacent
  parcels drift 3 cm apart has not produced a rendering artefact — it has produced
  a strip of land with no owner.

---

## The judgement (why the numbers are what they are)

The plugins are domain-agnostic. `snapPlugin` has never heard of a parcel. What
makes this package _cadastre_ is a page of decisions:

| Decision            | Value                                           | Why                                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Working CRS         | `EPSG:5254`, projected                          | A registry accepts planar metres, not degrees.                                                                                                                                                                           |
| Coordinate display  | `projected`, precision `3`                      | A surveyor reads `Y=458123.456 X=4421987.123` and types it back in. Millimetres, because that is what a coordinate schedule prints.                                                                                      |
| Snap tolerance      | **12 px**                                       | Tight. A loose tolerance _invents_ geometry — the pointer lands 30 px away, snapping drags it onto the corner anyway, and the stored parcel is not the one that was drawn. Slivers come from generous tolerances.        |
| Snap providers      | vertex, edge, midpoint, intersection, extension | No `perpendicular` by default: perpendicularity is an _inference_ about intent, and it silently rotates a boundary that was placed by coordinate.                                                                        |
| Double-click zoom   | **off**                                         | Double-click closes a ring here. Zooming as well would throw the surveyor off the work every time they finished a parcel.                                                                                                |
| Topological editing | **on**                                          | A shared corner moves in both parcels, in one command, or the parcels drift.                                                                                                                                             |
| `topology.autoFix`  | **off**                                         | The software reports; the surveyor decides. Even a `buffer(0)` "repair" changes the parcel's area, and the area is the number on the deed.                                                                               |
| Tolerance           | 1 mm                                            | Two coordinates closer than this are the same corner.                                                                                                                                                                    |
| Area unit           | `donum`                                         | 1 dönüm = 1 000 m². It is what the number is said out loud in.                                                                                                                                                           |
| Undo depth          | 200                                             | About an afternoon's digitising.                                                                                                                                                                                         |
| **Overlap**         | `error` — blocks the write                      | An overlap is a **dispute**. Two parcels claiming the same square metre is a claim about who owns it, and this software must not be the thing that quietly files it.                                                     |
| **Gap**             | `warning`                                       | A gap is usually a **digitisation artefact** — somebody's mouse missed a corner by 4 cm. Blocking the save would deadlock the work: you could not store parcel A until you had drawn B, and could not store B without A. |
| Sliver, min-area    | `warning`                                       | Same reasoning. Report loudly, block nothing.                                                                                                                                                                            |
| Missing ada/parsel  | `warning`                                       | The geometry is drawn _before_ the deed is typed. An `error` would make a parcel impossible to store until it was attributed.                                                                                            |

Set `strictTopology: true` to collapse the gap/sliver/min-area warnings into
errors. That is the right setting at a **submission boundary** — a batch import, a
server-side check — where a clean dataset is the contract rather than the goal.

### Area is derived, never typed

`yuzolcumu` is stamped onto every parcel by a commit middleware, computed from the
geometry in the working CRS, in m². Anything a human typed into that field is
overwritten. The number on the deed and the number implied by the boundary must be
the same number, and the only way to guarantee that is to make one of them
un-typeable. Turn it off with `deriveArea: false` if your server owns that number.

---

## Options

Every one of these has a defensible default; not one of them is a value we would
defend for every jurisdiction — which is exactly why it is an option. If you would
otherwise have to copy this package to change a number, the number is here.

| Option              | Default                                                   | What it does                                                                                                                                                    |
| ------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crs`               | `'EPSG:5254'`                                             | The projected working plane. Use your TUREF belt.                                                                                                               |
| `locale`            | `'tr'`                                                    | `'tr'` and `'en'` ship.                                                                                                                                         |
| `snapTolerance`     | `12`                                                      | Screen pixels.                                                                                                                                                  |
| `snapProviders`     | `['vertex','edge','midpoint','intersection','extension']` | Which snap sources to install.                                                                                                                                  |
| `gridSize`          | —                                                         | Metres. Omit for no grid snapping (the usual cadastral case).                                                                                                   |
| `minParcelArea`     | `1` (m²)                                                  | The floor below which a polygon is reported as suspiciously small. **Set this to your jurisdiction's ifraz minimum** and the rule starts saying something true. |
| `collections`       | `{ parcels: 'parcels', buildings: 'buildings' }`          | Rename to match an existing schema; draw, select, the layers and the rules all follow.                                                                          |
| `strictTopology`    | `false`                                                   | Promotes gap / sliver / min-area from `warning` to `error`.                                                                                                     |
| `precision`         | `3`                                                       | Decimal places in the working CRS's metres. 3 = mm.                                                                                                             |
| `tolerance`         | `0.001`                                                   | Metres. Below this, two coordinates are the same corner.                                                                                                        |
| `sliverRatio`       | `100`                                                     | perimeter²/area above which a polygon is a sliver.                                                                                                              |
| `maxGapArea`        | `1` (m²)                                                  | A void bigger than this is a road, not a slip of the mouse.                                                                                                     |
| `areaUnit`          | `'donum'`                                                 | Also `'m2' \| 'ha' \| 'km2'`.                                                                                                                                   |
| `lengthUnit`        | `'m'`                                                     |                                                                                                                                                                 |
| `historyLimit`      | `200`                                                     | Undo depth.                                                                                                                                                     |
| `handleSize`        | `10`                                                      | Vertex grab radius in px — a fingertip on a tablet in the field.                                                                                                |
| `attributeSeverity` | `'warning'`                                               | `'error'` at a submission boundary; `'off'` if attributes are captured elsewhere.                                                                               |
| `deriveArea`        | `true`                                                    | Recompute `yuzolcumu` on every write.                                                                                                                           |
| `areaDecimals`      | `2`                                                       | Decimals on the derived area.                                                                                                                                   |
| `parcelSchema`      | `parcelSchema`                                            | Replace or extend the parcel form's fields.                                                                                                                     |
| `basemap`           | —                                                         | A MapLibre style URL or style JSON. See `paleRasterBasemap()`.                                                                                                  |
| `attributions`      | `[]`                                                      | Your orthophoto's licence.                                                                                                                                      |

## The parcel schema

```ts
import { parcelSchema } from '@blaeu/preset-cadastre'
```

| field       | type                    | notes                                                                                                       |
| ----------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ada`       | string, required        | Block. A **string**: it is an identifier, it can carry a leading zero, and one day it arrives as `102/3-A`. |
| `parsel`    | string, required        | Parcel.                                                                                                     |
| `pafta`     | string                  | Sheet.                                                                                                      |
| `malik`     | string                  | Owner of record.                                                                                            |
| `nitelik`   | string                  | Land use / character.                                                                                       |
| `mevkii`    | string                  | Locality.                                                                                                   |
| `yuzolcumu` | number, m², **derived** | Computed from the geometry. Render it read-only.                                                            |

One schema drives both the form UI (labels are i18n _keys_, not literals) and the
`cadastre.attributes` validation rule. Two sources of truth for "what fields does a
parcel have" is how a form and a validator drift apart.

---

## Overriding it without forking

This is the part that matters. **A preset is a value, not a class** — you never
subclass it, you compose over it, and the later preset wins.

### Retune a plugin without re-declaring it

A municipality with a denser urban fabric wants a tighter snap and a real ifraz
minimum. It does _not_ restate the provider list, the CRS, or anything else:

```ts
import { composePresets, definePreset } from '@blaeu/core'
import { snapPlugin } from '@blaeu/plugin-snap'
import { minParcelArea } from '@blaeu/plugin-topology'
import { cadastrePreset } from '@blaeu/preset-cadastre'

export const izmirPreset = composePresets(
  cadastrePreset({ crs: 'EPSG:5253' }), // the national base, İzmir's belt (TUREF/TM27)
  definePreset({
    id: 'izmir',
    plugins: [[snapPlugin, { tolerance: 8 }]], // merged into the base's snap entry,
    // in place — providers survive untouched
    config: { crs: { precision: 4 } }, // deep-merged: the belt survives
    validation: [minParcelArea({ minArea: 250 })], // appended
    layers: [{ id: 'izmir-zoning', type: 'vector', source: 'zoning' }],
    i18n: { tr: { 'cadastre.attr.nitelik': 'Kullanım şekli' } },
  }),
)
```

Merge semantics, which are the contract:

| field                                                               | rule                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `config`, `theme`                                                   | deep merge, later wins                                                                                              |
| `plugins`                                                           | append — but a repeated plugin **id** deep-merges its options into the existing entry, keeping its install position |
| `validation`, `layers`, `commitMiddleware`, `interactionMiddleware` | append                                                                                                              |
| `i18n`                                                              | merge per locale, later wins per key                                                                                |
| `id`, `description`, `locale`                                       | later wins                                                                                                          |

### Replace instead of append

Appending cannot express "throw the base's rules away". That is what
`overridePreset` is for — a demo environment that must not enforce minimum area:

```ts
import { overridePreset } from '@blaeu/core'

const demo = overridePreset(cadastrePreset(), { validation: [] })
```

Needing this often is a smell that the base was too opinionated — tell us, and the
knob becomes an option.

### Build your own severities from the same parts

Everything the preset assembles is exported, so you can assemble a different one:

```ts
import { cadastreValidation, inCollection, resolveCadastreOptions } from '@blaeu/preset-cadastre'
import { noGapsWithNeighbours } from '@blaeu/plugin-topology'

// A jurisdiction that adjudicates gaps rather than tolerating them.
const rules = [
  ...cadastreValidation(resolveCadastreOptions({ attributeSeverity: 'off' })),
  inCollection(noGapsWithNeighbours({ severity: 'error' }), 'parcels'),
]
```

`inCollection(rule, collection)` is worth knowing about. It narrows a
domain-agnostic rule to one collection, and it is the reason the issue panel is
usable: unfiltered, `noOverlapWithNeighbours` cheerfully reports that every
building overlaps the parcel it stands on — which is true, and which is what
buildings do. A village of 400 houses would produce 400 errors on day one, the
surveyor would learn to ignore the panel, and the one real overlap in the dataset
would be lost in it.

### Style

```ts
import { cadastrePreset, paleRasterBasemap } from '@blaeu/preset-cadastre'

cadastrePreset({
  basemap: paleRasterBasemap(['https://ortho.example.gov.tr/{z}/{x}/{y}.png'], {
    attribution: 'Ortofoto © HGM',
    saturation: -0.9, // more suppression for an orthophoto than for a street map
    opacity: 0.5,
  }),
})
```

The basemap is _context_. Context that competes with the boundary is worse than no
context — which is why the theme is pale everywhere except the selection, and the
selection is magenta rather than blue (blue loses to an orthophoto).

Override tokens the same way you override anything else:

```ts
composePresets(
  cadastrePreset(),
  definePreset({
    id: 'high-contrast',
    theme: { tokens: { color: { selection: '#ff0000' } } }, // deep-merged
  }),
)
```

---

## What this package does _not_ do

- It does not import a plugin's internals, and no plugin imports it. The judgement
  lives here; the capability lives there. If you find `if (domain === 'cadastre')`
  inside a plugin, it escaped.
- It does not touch the DOM, a map, or a global. `cadastrePreset()` is a pure
  function returning a plain object — which is why it can be snapshot-tested,
  diffed, and shipped over the wire as config.
- It does not decide your legal minimums. `minParcelArea`'s default means "smaller
  than this is almost certainly a mis-click", not "smaller than this is illegal".
