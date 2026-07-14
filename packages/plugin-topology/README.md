# @fleximap/plugin-topology

Topology validation for FlexiMap: self-intersection, overlaps, gaps, slivers,
minimum area, and the two cheap structural checks that catch a bad import before
it reaches a boolean operation.

The geometry engine is [JSTS](https://github.com/bjornharrtell/jsts), run in the
**projected working CRS, in metres** — never in degrees. That is the single most
important sentence in this package. A `0.001` tolerance in degrees is about 100 m.

```bash
npm i @fleximap/plugin-topology
```

## Usage

```ts
import { createFlexiMap } from '@fleximap/core'
import { topologyPlugin } from '@fleximap/plugin-topology'

const map = await createFlexiMap({
  container: '#map',
  config: { crs: { working: 'EPSG:5254' } }, // TUREF / TM30 — a real cadastral plane
  plugins: [topologyPlugin({ tolerance: 0.001 })],
})

const topology = map.plugin('topology') // → TopologyApi, no cast

const issues = await topology.validate() // the whole store, e.g. after a batch import
for (const issue of issues) {
  console.log(issue.severity, issue.message, issue.at) // `at` drives "zoom to issue"
}

// Repairs are explicit. Always.
const fixable = issues.filter((i) => i.rule === 'topology.self-intersection')
if (fixable[0] && confirm(fixable[0].message)) topology.fix(fixable[0])
```

### Set the working CRS, or the numbers are fiction

The kernel's default working CRS is `EPSG:3857` (Web Mercator), where a metre is
not a metre: at Ankara's latitude every length is inflated by 1/cos(39.93°) ≈ 1.30
and every **area by 1.70**. A 200 m² overlap measures 340 m². Fine for a basemap,
useless for a land registry. Every product using this plugin should set a projected
CRS — which is exactly what a cadastre preset does for you.

## `autoFix` defaults to `false`, and it stays that way

Silently "correcting" a boundary is how software loses the trust of the people
whose job it is to be exactly right — and it loses it permanently, because once a
surveyor finds one parcel they did not move, they must re-check every parcel they
did not move.

**The software reports. The surveyor decides.** This is a product decision encoded
as a default, not a conservative guess.

Even the three repairs this package _can_ perform are lossy or opinionated:

| Rule                          | Repairable?      | Why                                                                                                    |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `topology.closed-rings`       | yes              | Nobody ever meant an unclosed ring.                                                                    |
| `topology.duplicate-vertices` | yes              | Nobody ever meant to digitise the same corner twice.                                                   |
| `topology.self-intersection`  | yes, **lossily** | `buffer(0)` can drop a lobe, which changes the parcel's area — and the area is the number on the deed. |
| `topology.overlap`            | **no**           | Two people claim the same ground. Which one yields is a legal act.                                     |
| `topology.gap`                | **no**           | Unclaimed land. Closing it _gives_ that land to somebody.                                              |
| `topology.slivers`            | **no**           | A thin parcel may be a right-of-way that genuinely exists.                                             |
| `topology.min-area`           | **no**           | An undersized parcel is a fact about the world, not a defect in the data.                              |

`fix()` returns `false`, and changes nothing, for the bottom four — forever. Every
repair that _does_ run goes through the command bus, so it undoes like any other
edit.

## What it registers

- **Plugin id** `topology` → `map.plugin('topology')` returns `TopologyApi` with no
  cast (the registry is augmented from `src/index.ts`).
- **Validation rules**, into `map.validation`: `topology.closed-rings`,
  `topology.duplicate-vertices`, `topology.self-intersection`, `topology.overlap`,
  `topology.gap`, `topology.slivers`.
  It does **not** register `topology.min-area` — the only honest minimum is the legal
  one in a particular jurisdiction, and the plugin does not know one. A preset adds it.
  It also **never overwrites a rule that is already registered under the same id**, so
  a preset's severities win.
- **i18n bundles** `en` and `tr`, for the rule messages. Every message goes through
  `ctx.t()`; there is no hardcoded English in an issue a user will read.

## What it emits

| Event             | Payload                                  | When                                                                                         |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `topology:issues` | `{ issues: readonly ValidationIssue[] }` | after every `validate()`, including the ones that find nothing — a UI has to clear its panel |

`onIssues(handler)` is the same stream as a `Disposable`.

## Dependencies

- `@fleximap/core` — **peer**. Never a direct dependency: two copies of the core
  means two event buses and two stores.
- `jsts` — a real dependency, bundled deep-imported (its package.json has no `main`
  and no `exports`, so a bare `import 'jsts'` fails at runtime under ESM).
- **No plugin dependencies at all**, optional or otherwise. Everything topology needs
  — the store, the spatial index, the CRS — is kernel.

## The rules

Each is exported individually, because severity is a **domain** decision: this plugin
knows how to find an overlap, but only a preset knows that an overlap is an error and
a gap is a warning.

```ts
import {
  noSelfIntersection,
  noOverlapWithNeighbours,
  noGapsWithNeighbours,
  minParcelArea,
  closedRings,
  noDuplicateVertices,
  noSlivers,
  topologyMessages,
} from '@fleximap/plugin-topology'

export const cadastre = definePreset({
  validation: [
    noSelfIntersection(), // error
    noOverlapWithNeighbours({ severity: 'error' }),
    noGapsWithNeighbours({ severity: 'warning', maxGapArea: 0.5 }),
    minParcelArea({ minArea: 25 }), // the legal minimum lives here, not in the plugin
    noSlivers({ sliverRatio: 100 }),
  ],
  i18n: topologyMessages, // the rules speak through t(); give them something to say
})
```

| Rule                        | Default severity | Finds                                                                                      |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `closedRings()`             | `error`          | a ring that does not close, or has fewer than three corners                                |
| `noDuplicateVertices()`     | `warning`        | consecutive vertices within `tolerance` **metres**                                         |
| `noSelfIntersection()`      | `error`          | a bowtie — with `at` set to the crossing coordinate                                        |
| `noOverlapWithNeighbours()` | `error`          | intersection area > `tolerance²` with any neighbour; `data.overlapArea` in m²              |
| `noGapsWithNeighbours()`    | `warning`        | a void < `maxGapArea` m² and < 2 × `maxGapWidth` wide, between the feature and a neighbour |
| `noSlivers()`               | `warning`        | perimeter²/area above `sliverRatio` (a square is 16; 100 ≈ a 1:20 strip)                   |
| `minParcelArea()`           | `error`          | planar area below `minArea` m², measured via `ctx.crs.area`                                |

### Why overlap is an error and a gap is only a warning

This asymmetry is a domain judgement, not an oversight. An overlap means two people
claim the same ground: somebody is wrong, and a registry must not store it even
transiently, because something will export it. A gap usually means nobody digitised
the shared edge twice from the same corner — an artefact of the drawing, not a claim
about the world. Blocking the write would strand a surveyor who has correctly recorded
what the monuments on the ground say.

A jurisdiction where unclaimed land between parcels is legally impossible should raise
it: `noGapsWithNeighbours({ severity: 'error' })`. That is why it is an option.

## How it stays fast, and honest

- **Neighbours come from the spatial index**, never a full scan. At 10 000 parcels a
  scan would be 10 000 projections and 10 000 overlays _per feature_.
- **Precision is reduced to the CRS's grid (1 mm) before every boolean op.** Two
  coordinates 1e-12 m apart are the same corner to a surveyor and a different corner
  to an overlay operation — and that difference is where slivers are born.
- **Structural rules run first.** An unclosed ring or a duplicate vertex fed to JTS
  produces either a crash whose stack trace blames the wrong code, or a plausible
  number that is wrong. `validate()` skips the expensive rules for any feature the
  cheap ones reject.

### Known limitation

`noGapsWithNeighbours` skips a pair that already shares an edge of real length. If two
parcels share _part_ of an edge and then diverge into a gap, that gap is not reported.
Detecting it means splitting shared boundaries, which is a bigger machine than this
rule — and the pair that touches nowhere, which is the common artefact, is caught.
