# Blaeu

Blaeu is a geospatial **kernel**, not a map viewer. The core owns five things — a typed
event bus with cancellable `before:` hooks, a plugin registry, two middleware pipelines
(one synchronous for interaction, one asynchronous for commits), a command bus, and a
feature store — and nothing else. Drawing, snapping, editing, measurement, selection,
undo/redo, topology, the coordinate-reference service, even layer _types_ are plugins that
register through extension points the core owns. Domains ship as **presets**: composable,
plain-data bundles of plugins, config, layers, validation rules, theme and messages. The
kernel has never heard of a parcel, and it never will.

The claim that follows from that, and the one this repository exists to make good on: the
same kernel drives a land-registry cadastre tool, an urban-planning tool, and a tile-based
game level editor — with no forks and no `if (domain === …)` anywhere inside it.

```
npm install @blaeu/core maplibre-gl
```

## Quick start

```ts
import { createBlaeuMap } from '@blaeu/core'
import { drawPlugin } from '@blaeu/plugin-draw'
import { snapPlugin } from '@blaeu/plugin-snap'
import { historyPlugin } from '@blaeu/plugin-history'

const map = await createBlaeuMap({
  container: '#map',
  crs: { working: 'EPSG:5254', display: 'projected', precision: 3 }, // TUREF/TM30, mm
  plugins: [snapPlugin({ tolerance: 12 }), drawPlugin({ collection: 'parcels' }), historyPlugin()],
})

map.tools.activate('draw:polygon')

map.events.on('draw:complete', (e) => {
  const parcel = e.payload.feature
  console.log(map.i18n.area(map.crs.area(parcel.geometry))) // planar m², in the working CRS
})
```

Ten lines, and the polygon you draw already snaps to the corners of every parcel already on
the map, is quantised to the millimetre grid of EPSG:5254, and is undoable with Ctrl+Z. The
draw plugin is responsible for none of that.

## The tier model

```
┌─────────────────────────────────────────────────────────────────────┐
│  Applications        your product. Knows about presets, not plugins. │
├─────────────────────────────────────────────────────────────────────┤
│  Presets             judgement: tolerances, severities, units, CRS,  │
│  preset-cadastre     layers, theme, locale. Plain data. Composable.  │
│  preset-urban        A preset is a value, not a subclass.            │
│  preset-game                                                         │
├─────────────────────────────────────────────────────────────────────┤
│  Plugins             capability: draw, snap, edit, select, measure,  │
│  plugin-draw …       history, topology, ui. Domain-agnostic. They    │
│                      peer-depend on core and never import each other.│
├─────────────────────────────────────────────────────────────────────┤
│  Core (the kernel)   EventBus · PluginManager · SyncInteractionPipe- │
│  @blaeu/core      line · AsyncCommitPipeline · CommandBus ·       │
│                      FeatureStore (+ spatial & topology indexes)     │
│                      + the seams: Renderer, CrsService, LayerManager,│
│                      ToolManager, ThemeManager, I18n, Validation     │
└─────────────────────────────────────────────────────────────────────┘
        the arrows only ever point down. CI enforces it:
        `npm run lint:boundaries` fails on a core→plugin or plugin→plugin import.
```

The distinction between the two middle tiers is the one worth internalising, because
getting it wrong is how every extensible library eventually stops being extensible:

- A **plugin** adds a _capability_. Snapping exists. Drawing exists. It is domain-agnostic;
  the snap plugin has never heard of a parcel.
- A **preset** adds _judgement_. Snap tolerance is 12 px because a looser one invents
  slivers. Overlaps are errors but gaps are warnings, because an overlap is a dispute and a
  gap is usually a slipped mouse. Area is planar because a land registry rejects spherical
  area.

If you find yourself writing `if (domain === 'cadastre')` inside a plugin, judgement has
leaked into the wrong tier.

## The same kernel powers all three

**Cadastre** — TUREF/TM projected working CRS, millimetre readouts, topological editing,
parcel-to-parcel topology rules, `ada`/`parsel` attribute schema.

```ts
import { createBlaeuMap } from '@blaeu/core'
import { cadastrePreset } from '@blaeu/preset-cadastre'

const map = await createBlaeuMap({
  container: '#map',
  preset: cadastrePreset({ crs: 'EPSG:5255', locale: 'tr' }), // İzmir belt
})
map.tools.activate('draw:polygon')
```

**Urban planning** — the same plugins, almost every number different, and one severity
inverted. A 20 px snap because a planner is sketching rather than reproducing a boundary
that legally exists; a 5 m planning grid, which cadastre would never accept; overlaps as
_warnings_, because a planner dragging a commercial zone across a residential one to see
what it looks like is doing their job.

```ts
import { urbanPlanningPreset } from '@blaeu/preset-urban'

const map = await createBlaeuMap({
  container: '#map',
  preset: urbanPlanningPreset({ crs: 'EPSG:5254', locale: 'tr' }),
})

const scenarios = map.plugin('scenario') // typed ScenarioApi, no cast
scenarios.create('Mevcut')
// …redraw a few blocks…
scenarios.create('Yoğun')
console.table(scenarios.compare('Mevcut', 'Yoğun').categories)
```

**A game level editor** — no basemap, no geodesy, no topology plugin (so the bundle does
not carry JSTS at all). The world is a plane in arbitrary units, registered through
`crs.register()`; the tile grid is a layer _type_ the core has never heard of; procedural
generation is commit middleware — the same seam cadastre uses for topology validation.

```ts
import { gameMapPreset } from '@blaeu/preset-game'

const map = await createBlaeuMap({
  container: '#map',
  preset: gameMapPreset({ gridSize: 32, gridType: 'square' }),
})

const entities = map.plugin('game-entity')
entities.setCurrent('tree')
await entities.place([128, -64]) // world units, snapped to the tile grid
```

That third one is the falsification test for the whole design. A game world has no Earth
under it. If the core had assumed geodesy anywhere — in the store, in the snap engine, in
the measurement maths — `preset-game` would be a fork rather than a package.

## The load-bearing decisions

Each of these is a constraint we accepted deliberately, and each is paid for by a property
you cannot get any other way. Full write-ups, including the alternatives we turned down,
are in [`docs/adr/`](docs/adr/).

### Every mutation is a Command, and history is a _subscriber_

The `Command` interface (`execute`/`undo`, with the contract that `undo(execute(s))`
restores `s` to **deep equality**) is the only way anything in BlaeuMap changes state.

The payoff is that undo works across plugins that have never heard of each other. The
history plugin does not know what a "move vertex" is; it subscribes to
`commands.onDidExecute`, keeps two stacks of `Command`s, and calls `undo()` on them. A
plugin written by a stranger in three years gets Ctrl+Z for free by implementing the
interface — no registration in history, no import of history, no coupling in either
direction. That is also why history is a plugin and not a core feature: a read-only viewer
or a kiosk does not pay for an undo stack it will never use, and a collaborative product
can swap in a history plugin backed by a CRDT without the kernel noticing.

`CommandBus.transaction(label, fn)` groups a multi-step operation into one undo step, and
rolls the store back if `fn` throws — so a half-completed parcel split cannot be left on
screen. `Command.coalesceWith()` merges a 200-frame vertex drag into a single Ctrl+Z,
which is what every user already assumes happens.

### Snapping is interaction middleware, not something the draw tool calls

This is the central architectural fact of the library, and it is worth stating flatly: the
draw plugin has never heard of the snap plugin and does not import it.

The snap plugin registers exactly one interaction middleware, at priority 100. On every
pointer event it queries its providers, picks a winner, and **rewrites `ctx.lngLat`** before
the pipeline reaches any tool. The draw tool then reads a position that is already exactly
on the parcel corner. So does the measure tool. So does the edit tool. So does a tool
written next year by someone who has never read this README — they get snapping for free,
because they read `ctx.lngLat` like everyone else.

Alt suppresses snapping for one event, as it does in every CAD package on earth. That
behaviour, too, is implemented once, in the middleware, and every tool inherits it.

The inverse arrangement — a `snapTo()` method that each tool remembers to call — appears
simpler for exactly as long as you have one tool, and then costs you a bug in every tool
that forgot.

### The interaction pipeline is synchronous; the commit pipeline is not

`InteractionMiddleware` returns `void`, not `Promise<void>`, and the type system enforces
it. That pipeline runs on every `pointermove` — up to 120 Hz. An async middleware there
adds a frame of latency and reorders events under load, which the user perceives as the
cursor lagging behind the snap indicator. Middleware that genuinely needs async work does
it speculatively and caches: the snap engine rebuilds its spatial index on `camera:idle`,
never on `pointermove`.

`CommitMiddleware` is `async` for the opposite reason. A real topology check calls a parcel
registry over the network. Blocking the main thread on that would freeze the map, and
callers already `await` the write, so the cost lands where it is visible.

Two pipelines, because the two jobs have opposite requirements. One pipeline would have to
be async, and then the cursor would lag.

### The store is WGS84; survey maths happens in a projected working CRS

Everything in the store, the events and the renderer is `[lng, lat]` in EPSG:4326, without
exception. One interior coordinate system means nothing downstream ever has to ask "which
one is this?".

But sphere maths is not survey maths. A spherical area on a 2 000 m² parcel at 39°N is
wrong by _square metres_ — enough to move a boundary in a dispute, and a land registry
cares. So every precise operation projects into the working CRS, does planar geometry in
metres, and projects back:

```ts
const plane = map.crs.working // EPSG:5254 — TUREF / TM30, metres
const xy = ring.map(plane.forward) // 4326 → projected metres
const out = offsetPolygonPlanar(xy, 2.5) // the real maths, in real metres
const back = out.map(plane.inverse) // → 4326, back into the store
```

`map.crs.area()`, `.length()`, `.distance()` and `.bearing()` are convenience wrappers
around that sandwich. `bearing()` returns **grid** bearing, clockwise from grid north, not
a geodesic azimuth — surveyors care about the difference. The working CRS is also what
coordinate readouts and exports use, because a Turkish surveyor wants to see
`Y=458123.456 X=4421987.123`, not a pair of decimal degrees. The Turkish TUREF/TM belts
(EPSG:5253–5259) and the legacy ED50 Gauss-Krüger belts (EPSG:2319–2325) ship built in, and
`crs.register()` takes a municipality's local system.

### The plugin registry is typed by declaration merging

```ts
declare module '@blaeu/core' {
  interface BlaeuPluginRegistry {
    draw: DrawApi
  }
}
```

After that, `map.plugin('draw')` is a `DrawApi` — no cast, no generic parameter, no import
of an internal type — and autocomplete lists every installed plugin by id. The same trick
on `BlaeuEventMap` makes `map.events.on('draw:complete', (e) => e.payload.feature)`
type-check with full inference, so a typo in an event name is a compile error rather than a
listener that silently never fires. `BlaeuPluginRegistry` ships empty on purpose. It is not
an oversight; it is the seam.

The `before:` prefix on an event name is not a convention either — it is a capability.
`EventBus.emitCancellable()` only accepts keys matching `` `before:${string}` ``, so a
cancellable hook and a past-tense notification cannot be confused by anyone, including us.

### Topological vertex identity: shared corners move together

`FeatureStore.topology` maps a **quantised** coordinate — snapped to the working CRS's
precision grid, 1 mm for cadastre — to every vertex sitting on it. Two adjacent parcels
sharing a corner therefore resolve to one key with two `VertexRef`s, and with
`editPlugin({ topological: true })` moving that corner moves both parcels in one command,
so one undo restores both.

The quantisation is the load-bearing part. Exact float equality would treat corners
10⁻¹² m apart as distinct; they would drift apart under editing; and you would have
manufactured a sliver. In a land registry a sliver is not a rendering artefact — it is a
strip of land with no owner, and eventually a court case.

## Write a plugin

A plugin is a function that returns an object. Here is a complete one — a snap provider for
parcel corners, the kind of thing a domain adds — including the registry augmentation that
buys the typed handle.

```ts
import type { BlaeuPlugin, LngLat, SnapCandidate, SnapProvider } from '@blaeu/core'

export interface CornerApi {
  readonly collection: string
}

declare module '@blaeu/core' {
  interface BlaeuPluginRegistry {
    'parcel-corner': CornerApi // → map.plugin('parcel-corner') is CornerApi, no cast
  }
}

export function parcelCornerPlugin(collection = 'parcels'): BlaeuPlugin<CornerApi> {
  return {
    id: 'parcel-corner',
    version: '1.0.0',
    // Optional, and genuinely so: with no snap engine installed the map still works,
    // it simply does not snap to corners. That claim owes a degradation test.
    dependencies: [{ id: 'snap', optional: true }],

    setup(ctx): CornerApi {
      const provider: SnapProvider = {
        id: 'parcel-corner',
        priority: 110, // above the built-in vertex provider (100): a corner outranks a vertex

        // Called on every pointer move, so it queries the spatial index. Never scans.
        query(point, tolerancePx, q): readonly SnapCandidate[] {
          const out: SnapCandidate[] = []
          for (const parcel of ctx.store.collection(collection).query(q.bbox)) {
            if (q.exclude.has(parcel.id)) continue // never snap to what you are dragging
            if (parcel.geometry.type !== 'Polygon') continue
            for (const ring of parcel.geometry.coordinates) {
              for (const position of ring) {
                const corner: LngLat = [position[0]!, position[1]!]
                const a = q.project(corner)
                const b = q.project(point)
                const distancePx = Math.hypot(a.x - b.x, a.y - b.y)
                if (distancePx > tolerancePx) continue
                out.push({
                  kind: 'parcel-corner',
                  point: corner,
                  distancePx,
                  priority: 110,
                  feature: parcel.id,
                  hint: ctx.i18n.t('corner.hint'),
                })
              }
            }
          }
          return out
        },
      }

      // Core invariant 5: every subscription goes into ctx.disposables, which the
      // kernel disposes on destroy. `?.` because the dependency is optional.
      const snap = ctx.tryPlugin('snap')
      if (snap) ctx.disposables.add(snap.addProvider(provider))
      else ctx.log.warn('no snap engine installed; parcel corners will not snap.')

      return { collection }
    },
  }
}
```

Install it and _every tool in the product_ — draw, edit, measure, and the one you have not
written yet — snaps to parcel corners. You did not touch any of them.

The three tests this plugin now owes are in [CONTRIBUTING.md](CONTRIBUTING.md): degradation
(it works without `snap`), teardown (removing it leaks nothing), and, for any plugin that
dispatches commands, the undo round-trip.

## Build a product preset

A preset is a **pure function returning plain data**. No map, no DOM, no globals. That is
what makes it inspectable, snapshot-testable, and composable.

```ts
import { definePreset, type Preset } from '@blaeu/core'
import { drawPlugin } from '@blaeu/plugin-draw'
import { snapPlugin } from '@blaeu/plugin-snap'
import { historyPlugin } from '@blaeu/plugin-history'
import { topologyPlugin, noOverlapWithNeighbours, closedRings } from '@blaeu/plugin-topology'

export interface UtilityOptions {
  readonly crs?: string
  readonly snapTolerance?: number
}

export function utilityNetworkPreset(options: UtilityOptions = {}): Preset {
  return definePreset({
    id: 'utility-network',
    description: 'Pipe and cable networks: metric working CRS, tight snapping, no overlaps.',

    config: {
      crs: { working: options.crs ?? 'EPSG:5254', display: 'projected', precision: 2 },
      interaction: { doubleClickZoom: false }, // double-click ends a run
    },

    // Tuple form: the factory stays *un-invoked* until the map installs it, which is
    // what lets a later preset retune these options without re-declaring the plugin.
    plugins: [
      [snapPlugin, { tolerance: options.snapTolerance ?? 8, providers: ['vertex', 'edge'] }],
      [drawPlugin, { defaultMode: 'line', collection: 'mains' }],
      [topologyPlugin, { autoFix: false }],
      [historyPlugin, { limit: 200 }],
    ],

    // The plugin knows how to *find* an overlap. Only this preset knows that in a
    // pipe network an overlap is fatal. Severity is judgement; judgement is preset.
    validation: [
      closedRings({ severity: 'error' }),
      noOverlapWithNeighbours({ severity: 'error' }),
    ],

    layers: [{ id: 'mains', type: 'vector', source: 'mains' }],
    locale: 'tr',
  })
}
```

### Retuning a preset without forking it

`composePresets` is how a municipality customises a national preset. Later wins:

```ts
import { composePresets, definePreset, createBlaeuMap } from '@blaeu/core'
import { cadastrePreset } from '@blaeu/preset-cadastre'
import { snapPlugin } from '@blaeu/plugin-snap'
import { minParcelArea } from '@blaeu/plugin-topology'

const izmir = composePresets(
  cadastrePreset({ crs: 'EPSG:5255' }), // national base
  definePreset({
    id: 'izmir',
    plugins: [[snapPlugin, { tolerance: 8 }]], // retunes the base's snap; keeps its provider list
    validation: [minParcelArea({ severity: 'error', minArea: 250 })], // appended
    config: { crs: { precision: 4 } }, // deep-merged over the base
    layers: [{ id: 'izmir-zoning', type: 'vector', source: 'zoning' }],
  }),
)

const map = await createBlaeuMap({ container: '#map', preset: izmir })
```

The merge semantics are the whole contract of the preset system, and they are deliberate:

| Field                                                               | Rule                                                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `config`, `theme`                                                   | deep merge                                                                                      |
| `plugins`                                                           | append — but a repeated plugin id **deep-merges its options into the existing entry, in place** |
| `validation`, `layers`, `interactionMiddleware`, `commitMiddleware` | append                                                                                          |
| `i18n`                                                              | merge per locale, later wins per key                                                            |
| `id`, `description`, `locale`                                       | later wins                                                                                      |

In place matters: the retuned snap plugin keeps the base preset's install position, so
anything depending on it still finds it where the base put it. When append is genuinely
wrong — a demo environment that must not enforce minimum parcel area — `overridePreset(base, { validation: [] })`
replaces instead. Needing that often is a smell that the base preset should have exposed an
option.

## Packages

| Package                  | Install                         | What it is                                                                       |
| ------------------------ | ------------------------------- | -------------------------------------------------------------------------------- |
| `@blaeu/core`            | `npm i @blaeu/core maplibre-gl` | The kernel, the MapLibre renderer, and `@blaeu/core/testing`                     |
| `@blaeu/plugin-snap`     | `npm i @blaeu/plugin-snap`      | Snapping as interaction middleware; 7 built-in providers, pluggable              |
| `@blaeu/plugin-draw`     | `npm i @blaeu/plugin-draw`      | point / line / polygon / rectangle / circle / freehand                           |
| `@blaeu/plugin-edit`     | `npm i @blaeu/plugin-edit`      | Vertex editing, transforms, split, merge. Topological mode. JSTS                 |
| `@blaeu/plugin-select`   | `npm i @blaeu/plugin-select`    | Click, multi-select, box, lasso                                                  |
| `@blaeu/plugin-measure`  | `npm i @blaeu/plugin-measure`   | Distance, area, grid bearing — planar, in the working CRS                        |
| `@blaeu/plugin-history`  | `npm i @blaeu/plugin-history`   | Undo/redo for every plugin, including the ones that do not exist yet             |
| `@blaeu/plugin-topology` | `npm i @blaeu/plugin-topology`  | Overlap, gap, sliver, self-intersection, ring closure. JSTS                      |
| `@blaeu/plugin-ui`       | `npm i @blaeu/plugin-ui`        | Framework-free chrome: toolbar, readouts, undo buttons, issue panel              |
| `@blaeu/preset-cadastre` | `npm i @blaeu/preset-cadastre`  | Turkish cadastre: TUREF/TM, mm precision, topological editing, ada/parsel        |
| `@blaeu/preset-urban`    | `npm i @blaeu/preset-urban`     | Zoning legend, 5 m planning grid, scenario comparison                            |
| `@blaeu/preset-game`     | `npm i @blaeu/preset-game`      | Tile/hex level editor: custom world CRS, entity placement, procedural generation |

Every plugin declares `@blaeu/core` as a **peerDependency**, never a dependency. Two
copies of the core in a user's `node_modules` means two event buses and two stores; nothing
throws, the plugin just silently never receives an event, and someone loses a day to it.

## What this is _not_, and what is unfinished

A library honest about its edges is worth more than one that is not, so:

- **The MapLibre renderer has no browser-mode test coverage.** The entire suite (500+ tests)
  runs headless against `FakeRenderer`, which implements the full `Renderer` contract with
  deterministic, analytically-invertible `project`/`unproject`. That is what makes a
  pixel-denominated snap tolerance testable at all, and it proves the renderer seam is real
  rather than aspirational — but it means `MapLibreRenderer` itself is verified by reading
  and by hand. A browser-mode Vitest run against a real WebGL context is the highest-value
  test we have not written.
- **The commit pipeline is not automatically run by `commands.dispatch()`.** Commands are
  synchronous; the commit pipeline is async. Today, a write that must be validated runs
  `await map.commit.run(ctx)` first and dispatches only if it was not rejected — which is
  what `preset-game`'s entity placement does, and it is the pattern to copy. Making
  `dispatch` async would make every tool's click handler async; making the pipeline sync
  would forbid a server-side check. Resolving that properly (probably a `dispatchAsync`)
  is on the roadmap and is a contract change, so it will get an ADR.
- **No React (or Vue, or Svelte) binding.** `@blaeu/plugin-ui` is framework-free DOM on
  purpose, and every subscription returns a `Disposable` that maps cleanly onto an effect
  cleanup — but there is no `@blaeu/react` package yet.
- **No 3D and no terrain.** The `Renderer` interface is the seam a Three.js renderer would
  come through, and `Camera` already carries `pitch`, but nothing behind that seam exists.
- **Collaboration is designed for, not built.** The command bus is the right seam for it
  (see ADR 0002 and the roadmap), and nothing in the architecture fights it. That is not the
  same as it working.
- **Not a basemap or a tile server.** Bring your own MapLibre style.
- **Not a replacement for a GIS.** No reprojection of raster data, no geoprocessing suite,
  no attribute joins across datasets. It is an _editing_ kernel.

## Further reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — every core abstraction, the life of a pointer event,
  the life of a mutation, plugin dependency resolution, and the extension-point catalogue.
- [ROADMAP.md](ROADMAP.md) — what is next, and why in that order.
- [CONTRIBUTING.md](CONTRIBUTING.md) — the boundary rules, the three tests every plugin
  owes, and when a change needs an ADR.
- [docs/adr/](docs/adr/) — the decisions, each with the alternatives we rejected.

MIT.
