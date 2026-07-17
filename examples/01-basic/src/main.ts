/**
 * BlaeuMap — 01. Basic usage.
 *
 * The sixty-second introduction, and the file to read first.
 *
 * There is **no preset here**. A preset (see `@blaeu/preset-cadastre`) is the
 * normal way to ship a product, but it bundles the plugins, the layers, the theme,
 * the CRS and the validation rules into one call — which is exactly what you do
 * *not* want when you are trying to understand what the thing is made of. So this
 * example assembles the parts by hand:
 *
 *     kernel  +  snap  +  draw  +  select  +  history  +  ui
 *
 * Read the plugin list below and notice what the kernel does not have. There is no
 * `map.draw()`, no `map.enableSnapping()`, no `map.undo()`. The kernel owns an event
 * bus, a plugin registry, two middleware pipelines, a command bus and a feature
 * store. Everything a user would call a *feature* is a plugin standing on top of
 * those five things — including every plugin below, and including the ones you are
 * going to write.
 */

import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'

// A namespace import, because the escape hatch at the bottom of this file wants
// both the `maplibregl.Map` *type* and the `NavigationControl` *value*.
import * as maplibregl from 'maplibre-gl'

import { AddFeaturesCommand, MapLibreRenderer, createBlaeuMap } from '@blaeu/core'
import type { FeatureInput, LayerSpec } from '@blaeu/core'
import { PREVIEW_COLLECTION, drawPlugin } from '@blaeu/plugin-draw'
import { historyPlugin } from '@blaeu/plugin-history'
import { selectPlugin } from '@blaeu/plugin-select'
import { snapPlugin } from '@blaeu/plugin-snap'
import { uiPlugin } from '@blaeu/plugin-ui'

/** Where drawn and seeded geometry lives. A collection maps 1:1 to a renderer source. */
const PARCELS = 'parcels'

/* ========================================================================= */
/* 1. Layers                                                                 */
/* ========================================================================= */

/**
 * Layers are declared, not imperatively added, and each one names a registered
 * *layer type* rather than a renderer primitive.
 *
 * `vector` and `raster` are the two the core ships. A plugin can register a third
 * — `heatmap`, `deckgl`, `fog-of-war` — and it becomes usable through this same
 * array without the core knowing it exists. That indirection is why the basemap
 * below is data rather than a MapLibre style object.
 *
 * Order is draw order: the basemap is declared first, so everything else sits on
 * top of it.
 */
const layers: readonly LayerSpec[] = [
  {
    id: 'basemap',
    type: 'raster',
    config: {
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
    },
  },
  {
    id: 'parcels',
    type: 'vector',
    source: PARCELS,
    style: {
      // 12 % fill: enough to hit-test and to read as a body, nowhere near enough to
      // compete with the outline. A parcel *is* its boundary.
      fill: { color: '#2563eb', opacity: 0.12, outlineColor: '#1d4ed8' },
      line: { color: '#1d4ed8', width: 2 },
      // Points and vertices of drawn features, so a `draw:point` is visible too.
      circle: { color: '#1d4ed8', radius: 4, strokeColor: '#ffffff', strokeWidth: 1.5 },
    },
  },

  /**
   * The rubber band — the shape in progress, before it is committed.
   *
   * The draw plugin *creates* this collection but declares no layer for it, which is
   * the correct division of labour even though it costs you these eight lines: how a
   * preview should look is a product decision (dashed and grey in a cadastre app,
   * neon in a game), and a plugin that hard-coded a style would have made it for you.
   * A collection is data; a layer is a decision about how to show it.
   *
   * Declared last, so it sits above the committed parcels. A rubber band hidden
   * behind the geometry you are drawing over is a rubber band nobody can use.
   */
  {
    id: 'draw-preview',
    type: 'vector',
    source: PREVIEW_COLLECTION,
    style: {
      fill: { color: '#f59e0b', opacity: 0.15 },
      line: { color: '#f59e0b', width: 2, dasharray: [2, 1.5] },
      circle: { color: '#f59e0b', radius: 4, strokeColor: '#ffffff', strokeWidth: 1.5 },
    },
  },
]

/* ========================================================================= */
/* 2. The map                                                                */
/* ========================================================================= */

const map = await createBlaeuMap({
  container: '#map',

  /**
   * The store is always WGS84 (core invariant 3), but *sphere maths is not survey
   * maths*: a spherical area on a 2 000 m² parcel at 40°N is wrong by square
   * metres, which is enough to move a boundary in a dispute.
   *
   * So every precise operation — area, length, the snap engine's grid, the metric
   * tolerances everywhere — projects into this **working CRS**, does planar maths
   * in metres, and projects back. EPSG:5255 is TUREF / TM33, the Turkish belt that
   * contains Ankara. Change this line and every number in the app changes with it;
   * no other line has to.
   */
  crs: { working: 'EPSG:5255', precision: 3 },

  camera: { center: [32.8543, 39.9206], zoom: 17.5 },

  /**
   * Constructing the renderer by hand rather than letting the kernel default it,
   * for one reason: `doubleClickZoom`.
   *
   * Double-click closes a polygon. If MapLibre also zooms on double-click, finishing
   * a ring throws the user two zoom levels in. Turning MapLibre's own gesture off is
   * the map owner's decision — the renderer just carries it across.
   */
  renderer: new MapLibreRenderer({
    interaction: { doubleClickZoom: false },
    mapOptions: { maxZoom: 21, attributionControl: false },
  }),

  layers,

  /**
   * The whole product, in five lines.
   *
   * Order does not matter here — the plugin manager resolves declared dependencies
   * and installs in the right order — but *reading* order does, so they are listed
   * the way the data flows: a pointer event is snapped, then drawn with, then the
   * result can be selected, and every mutation lands on the undo stack, and the UI
   * watches all of it.
   */
  plugins: [
    // 12 screen pixels of "close enough". Not metres: "close" is a thing the user
    // judges with their eyes, and their eyes are looking at a screen.
    snapPlugin({ tolerance: 12 }),
    drawPlugin({ collection: PARCELS }),
    selectPlugin({ collections: [PARCELS] }),
    historyPlugin({ limit: 100 }),
    uiPlugin({ attributions: ['© OpenStreetMap contributors'] }),
  ],
})

/* ========================================================================= */
/* 3. The typed plugin handle — the DX payoff                                */
/* ========================================================================= */

/**
 * `map.plugin('draw')` is a `DrawApi`. **There is no cast here, and no generic
 * parameter.** Hover it in your editor.
 *
 * The core has never heard of the draw plugin, so how does it know? The draw
 * plugin's entry point declaration-merges itself into the core's registry:
 *
 * ```ts
 * declare module '@blaeu/core' {
 *   interface BlaeuPluginRegistry { draw: DrawApi }
 * }
 * ```
 *
 * `BlaeuPluginRegistry` ships *empty* from the core. That empty interface is not an
 * oversight, it is the seam — importing `@blaeu/plugin-draw` is what teaches the
 * kernel that `'draw'` is a valid id and that it resolves to `DrawApi`. Autocomplete
 * on `map.plugin('` lists exactly the plugins you installed, a typo in the id is a
 * compile error, and a plugin a stranger writes next year is as first-class as this
 * one. Remove the `drawPlugin` import above and the next line stops compiling.
 */
const draw = map.plugin('draw')
const history = map.plugin('history')
const ui = map.plugin('ui')

// `tryPlugin` is the same thing for an *optional* dependency: `undefined` instead of
// a throw. It is how a plugin enhances another one it cannot assume is installed.
const snap = map.tryPlugin('snap')

/* ========================================================================= */
/* 4. Typed events                                                           */
/* ========================================================================= */

const feed = document.querySelector<HTMLElement>('#feed')

/**
 * `BlaeuEventMap` is augmented the same way `BlaeuPluginRegistry` is, so the payload
 * below is fully inferred: `e.payload.feature` is a `BlaeuFeature`, `e.payload.mode`
 * is a `DrawMode` union. Nothing is `any`, and nothing was cast.
 */
map.events.on('draw:complete', (e) => {
  const { feature, mode } = e.payload

  // The projection sandwich, done for you: `crs.area` projects the ring into the
  // working CRS, computes a planar area in m², and comes back. This is the number a
  // land registry will accept; a spherical one is not. A line or a point has no
  // area, so fall back to its length — also metres, also planar.
  const area = map.crs.area(feature.geometry)
  const size =
    area > 0 ? `${area.toFixed(2)} m²` : `${map.crs.length(feature.geometry).toFixed(2)} m`

  log(`draw:complete — ${mode} · ${size}`)
})

/**
 * The proof that the type is doing work. Uncomment the line without the directive
 * and `tsc` fails; leave it as it is and `tsc` fails if the typo ever *becomes*
 * valid — `@ts-expect-error` errors when there is no error to expect.
 *
 * This is the difference between a stringly-typed event bus and this one: a
 * mistyped event name is not a listener that silently never fires at 3 a.m. It is a
 * red squiggle now.
 */
// @ts-expect-error — 'draw:complet' is not a key of BlaeuEventMap. A typo in an event name does not compile.
map.events.on('draw:complet', () => log('this listener can never exist'))

// Selection reports deltas, not just the new set — a table binding that only got the
// set would have to diff it against its own copy to know which row to un-highlight.
map.events.on('select:changed', (e) => {
  const ids = [...e.payload.selected]
  const total = ids
    .map((id) => map.store.find(id))
    .reduce((sum, f) => sum + (f ? map.crs.area(f.geometry) : 0), 0)

  log(
    ids.length === 0
      ? 'select:changed — nothing selected'
      : `select:changed — ${ids.length} feature(s), ${total.toFixed(2)} m² total`,
  )
})

// `snap:changed` is emitted by the snap plugin and typed by the snap plugin, and the
// core knows nothing about either. It fires only when the target actually *changes*,
// so this status line does not repaint 120 times a second while the cursor rests on
// a corner.
map.events.on('snap:changed', (e) => {
  const candidate = e.payload.result?.candidate
  ui.status.set('snap', candidate ? `snapped to ${candidate.kind}` : '')
})

map.events.on('history:changed', (e) => {
  ui.status.set('history', e.payload.canUndo ? `${e.payload.depth} undoable step(s)` : '')
})

/* ========================================================================= */
/* 5. Seed geometry — something to snap to                                   */
/* ========================================================================= */

/**
 * Two adjacent parcels sharing an edge, so there are corners on screen from the
 * first frame.
 *
 * Note *how* they get in: not `store.add()` — there is no such method — but a
 * `Command` dispatched through the bus. Every mutation in BlaeuMap is a command with
 * an `execute` and an `undo` (core invariant 2), which is the entire reason the
 * history plugin can offer undo for a plugin it has never heard of.
 */
const seeds: readonly FeatureInput[] = [
  {
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [32.8535, 39.9203],
          [32.8543, 39.9203],
          [32.8543, 39.9209],
          [32.8535, 39.9209],
          [32.8535, 39.9203],
        ],
      ],
    },
    properties: { ada: '102', parsel: '7' },
  },
  {
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [32.8543, 39.9203],
          [32.8551, 39.9203],
          [32.8551, 39.9209],
          [32.8543, 39.9209],
          [32.8543, 39.9203],
        ],
      ],
    },
    properties: { ada: '102', parsel: '8' },
  },
]

// A durable write commits — it runs the commit pipeline (validation, derived fields)
// and lands on the undo stack. `dispatch()` is only for transient scaffolding and
// refuses a CommitCommand like this one, at compile time and at runtime.
await map.commands.commit(new AddFeaturesCommand(PARCELS, seeds, { label: 'Load parcels' }))

// Loading a document is not something the user did, so it is not something they
// should be able to undo their way back past. Clearing after a load is the normal
// pattern — the same call belongs after a save.
history.clear()

/* ========================================================================= */
/* 6. The thesis of the library                                              */
/* ========================================================================= */

/**
 * Start drawing on a corner of a seeded parcel and the vertex lands *exactly* on it.
 *
 * **The draw plugin did not do that, and does not know it happened.** It has never
 * heard of the snap plugin, does not import it, and has no code path that consults
 * it. Snapping is registered as *interaction middleware*: on every pointer event it
 * runs before any tool, queries its providers, and **rewrites `ctx.lngLat`**. The
 * draw tool then reads a position that has already been snapped — as does the select
 * tool, the measure tool, and a tool written by a stranger next year who has never
 * read this file.
 *
 * That indirection is the whole library. A mapping toolkit where `drawTool` calls
 * `snapEngine.snap(point)` has, at that moment, decided that snapping means whatever
 * the draw tool asks for, forever; only tools that remember to call it snap, and a
 * third-party tool never does. BlaeuMap put the seam one level down, in the pipeline,
 * and got snapping for tools that do not exist yet.
 *
 * Two things follow, and both are visible in this file:
 *
 *  - Delete `snapPlugin()` from the plugin list and everything still works. Drawing
 *    just stops snapping. (`snap` below is `SnapApi | undefined` for exactly that
 *    reason — see `tryPlugin`.)
 *  - `snapPlugin` is configured here, in the app, by someone who is not the author of
 *    either plugin.
 */
snap?.setTolerance(12)

// The snap engine is open-ended in the same way: `addProvider` takes a source of
// snap targets, and every tool in the product snaps to them from the next pointer
// move. A cadastre plugin registers 'parcel-corner'; a game plugin registers
// 'hex-centre'. Neither has to touch the draw plugin, and neither has to touch us.

/* ========================================================================= */
/* 7. The escape hatch                                                       */
/* ========================================================================= */

/**
 * `getNative<T>()` is the one sanctioned way out of the abstraction (core invariant
 * 6), and it exists because the alternative is worse: the first time we have not
 * wrapped something, you fork the library.
 *
 * So take the MapLibre map and add MapLibre's own zoom/compass control. But be clear
 * about what you give up the moment you cross this line:
 *
 *  - **Nothing you do here is undoable.** The history plugin records `Command`s. A
 *    MapLibre layer you add directly never became one, so Ctrl+Z will not remove it.
 *  - **Nothing you do here survives a renderer swap.** Point the map at the
 *    `FakeRenderer` (that is how the whole test suite runs headless) or at a future
 *    deck.gl renderer and this call throws or returns something else entirely.
 *  - **Nothing you do here is themed, localised, validated or persisted.** Those
 *    live in the kernel, and you have just stepped around it.
 *
 * That is a fine trade for a zoom button. It is a bad trade for a data layer — which
 * is why the parcels above are a `LayerSpec` and not a `maplibre.addLayer` call.
 * Grep for `getNative` in a codebase and you have a list of everywhere it left the
 * building; that greppability is the point of making the hatch explicit.
 */
const native = map.renderer.getNative<maplibregl.Map>()
native.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right')

/* ========================================================================= */
/* 8. Odds and ends                                                          */
/* ========================================================================= */

// The UI plugin's toolbar was never configured with a list of buttons: it derives
// them from `tools.list()`, which is whatever the installed plugins happened to
// register. Install the measure plugin tomorrow and a measure button appears with no
// change to this file.
ui.status.set('hint', 'Pick a tool, then click on the map. Alt suppresses snapping.')

// Start in polygon mode so the page is useful on first click. Equivalent to
// `map.tools.activate('draw:polygon')` — the typed API is just nicer to read.
draw.start('polygon')

// Handy in the console: `map.debug.snapshot()` reports listener, middleware, layer,
// plugin and feature counts. The teardown test in `blaeu-testing` asserts they all
// return to zero after `map.destroy()`, and you can watch that happen live here.
declare global {
  interface Window {
    map: typeof map
  }
}
window.map = map

function log(message: string): void {
  if (feed) feed.textContent = message
}

/* ========================================================================= */
/* 9. Theme switching — the whole map follows                                */
/* ========================================================================= */

/**
 * `map.theme.list()` enumerates every registered theme (the six built-ins plus any
 * the app registered), and `map.theme.use(id)` activates one. There is nothing here
 * that knows a colour: the plugins read their own colours from the theme tokens and
 * restyle themselves, and the parcel layers follow through a token-driven style. A
 * built-in theme also swaps the *basemap* to its own flat ground, which the OSM
 * tiles here sit on top of — toggle them off to see it.
 */
const themeBar = document.querySelector<HTMLElement>('#themes')
const buttons = new Map<string, HTMLButtonElement>()

function markActiveTheme(): void {
  const active = map.theme.current.id
  for (const [id, btn] of buttons) btn.setAttribute('aria-pressed', String(id === active))
  document.querySelector('#theme-auto')?.setAttribute('aria-pressed', 'false')
}

if (themeBar) {
  for (const theme of map.theme.list()) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = theme.id
    btn.addEventListener('click', () => {
      map.theme.use(theme.id)
      markActiveTheme()
      log(`Theme: ${theme.id} (${theme.scheme})`)
    })
    buttons.set(theme.id, btn)
    themeBar.append(btn)
  }
  markActiveTheme()
}

document.querySelector<HTMLButtonElement>('#theme-auto')?.addEventListener('click', (e) => {
  // Follow the OS setting and flip live when it changes; an explicit theme button
  // afterwards takes back manual control.
  map.theme.follow('auto')
  for (const btn of buttons.values()) btn.setAttribute('aria-pressed', 'false')
  ;(e.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', 'true')
  log(`Theme: following OS → ${map.theme.current.id} (${map.theme.scheme})`)
})

const tilesToggle = document.querySelector<HTMLButtonElement>('#tiles-toggle')
tilesToggle?.addEventListener('click', () => {
  const on = tilesToggle.getAttribute('aria-pressed') === 'true'
  map.layers.get('basemap')?.setVisible(!on)
  tilesToggle.setAttribute('aria-pressed', String(!on))
  tilesToggle.textContent = `Basemap tiles: ${!on ? 'on' : 'off'}`
})
