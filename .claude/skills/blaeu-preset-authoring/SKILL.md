---
name: blaeu-preset-authoring
description: How to build a BlaeuMap domain preset — the composable bundle of plugins, config, layers, validation rules, theme and i18n that turns the kernel into a vertical product. Use when creating a packages/preset-* or when a user asks how to target a new industry without forking.
---

# Authoring a domain preset

A preset is the answer to "how does the same kernel become a cadastre system _and_
a game level editor?" It is a **data structure**, not a subclass — which is what
makes it composable, diffable, and overridable at every level.

```ts
export function cadastrePreset(opts: CadastreOptions = {}): Preset {
  const crs = opts.crs ?? 'EPSG:5254' // TUREF / TM30 — central Türkiye
  return definePreset({
    id: 'cadastre',

    config: {
      crs: { working: crs, display: 'projected', precision: 3 }, // 1 mm readout
      interaction: { doubleClickZoom: false }, // double-click closes a ring here
    },

    plugins: [
      [
        snapPlugin,
        { tolerance: 12, providers: ['vertex', 'edge', 'midpoint', 'intersection', 'extension'] },
      ],
      [drawPlugin, { defaultMode: 'polygon', closeTolerance: 0 }],
      [editPlugin, { topological: true }], // shared corners move together
      [topologyPlugin, { autoFix: false }], // a surveyor decides, not us
      [measurePlugin, { areaUnit: 'm2', planar: true }],
      [historyPlugin, { limit: 200 }],
    ],

    validation: [
      noSelfIntersection({ severity: 'error' }),
      noOverlapWithNeighbours({ severity: 'error', tolerance: 0.001 }),
      noGapsWithNeighbours({ severity: 'warning', maxSliverArea: 0.5 }),
      minParcelArea({ severity: 'warning', min: 1 }),
      closedRings({ severity: 'error' }),
    ],

    layers: [
      { id: 'parcels', type: 'vector', source: 'parcels', style: parcelStyle },
      { id: 'buildings', type: 'vector', source: 'buildings', style: buildingStyle },
    ],

    theme: cadastreTheme,
    i18n: { tr: trMessages, en: enMessages },
    locale: opts.locale ?? 'tr',
  })
}
```

Used as:

```ts
const map = await createBlaeuMap({
  container: '#map',
  preset: cadastrePreset({ crs: 'EPSG:5255', locale: 'tr' }),
})
```

## The three rules that keep presets composable

**1. A preset is a value, not a side effect.** `cadastrePreset()` must not touch a
map, a DOM node, or a global. It returns a plain object. That is what lets it be
inspected, merged, snapshot-tested, and shipped over the wire as config.

**2. Presets compose, and the _later_ one wins.** This is how a municipality
customises a national preset without forking it:

```ts
const izmirPreset = composePresets(
  cadastrePreset({ crs: 'EPSG:5255' }), // national base
  definePreset({
    id: 'izmir',
    validation: [minParcelArea({ min: 250 })], // appended to the base's rules
    config: { crs: { precision: 4 } }, // deep-merged over the base
    layers: [{ id: 'izmir-zoning', type: 'vector', source: 'zoning' }],
  }),
)
```

Merge semantics are deliberate and worth knowing: `config` and `theme` **deep
merge**; `plugins`, `validation`, `layers` and `middleware` **append** (with
plugin options for a repeated `id` deep-merging into the earlier entry, so you
can retune a plugin without re-declaring it); `i18n` merges per-locale. If you
ever need _replace_ rather than _append_, that is what
`overridePreset(base, { validation: [...] })` is for — and needing it often is a
smell that the base preset was too opinionated.

**3. Every knob a domain expert would touch belongs in `Options`, not in the
body.** The test: if a user has to copy your preset file to change a number, that
number should have been an option. CRS, locale, tolerances, units, and severity
levels are almost always options.

## What goes in a preset vs. a plugin

A **plugin** adds a _capability_ — snapping exists, drawing exists. It should be
domain-agnostic: the snap plugin knows nothing about parcels.

A **preset** adds _judgement_ — snap tolerance is 12 px because that's what
surveyors expect at cadastral scale; area is planar in metres because a land
registry rejects spherical area; overlaps are errors but gaps are warnings
because a sliver is usually a digitisation artefact and an overlap is usually a
dispute.

If you're writing an `if (domain === 'cadastre')` inside a plugin, that judgement
escaped into the wrong layer. Move it to a preset option.

## Turkish cadastre specifics worth encoding

These are the details that make the difference between a demo and something a
Kadastro Müdürlüğü would actually use, and they belong in the preset:

- **Projected CRS by default.** The TUREF/TM zones (EPSG:5253–5259, 3° belts) and
  the legacy ED50 Gauss-Krüger zones. Area and distance _must_ be planar; a
  spherical area on a parcel is off by enough to matter legally.
- **Millimetre precision** in coordinate readouts and exports (`precision: 3`), and
  a snap tolerance tight enough not to invent slivers.
- **`ada/parsel` as first-class attributes**, not free-form properties — the
  attribute schema in the preset drives the form UI and the validation.
- **Turkish as the default locale**, with the domain vocabulary right: _parsel_,
  _ada_, _pafta_, _malik_, _yüzölçümü_, _sınırlandırma_. Translating "parcel" to
  "parça" is the kind of thing that instantly tells a surveyor you didn't ask one.
- **Topological editing on** — a shared boundary between two parcels is one
  boundary, and moving a corner moves it for both. This is the whole ballgame; a
  system that lets two adjacent parcels drift apart by 3 cm has created a legal
  problem, not a rendering artefact.
