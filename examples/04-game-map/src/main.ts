/**
 * BlaeuMap example 04 — a game map / level editor.
 *
 * ## Read this file for one idea
 *
 * It is the **same kernel** as the cadastre example. Not a fork, not a "game mode",
 * not a second rendering path. The same `@blaeu/core`, the same command bus, the
 * same interaction pipeline, the same snap plugin. What changed is entirely outside
 * the kernel:
 *
 * - **No basemap.** The preset's theme is one MapLibre `background` layer. Nothing
 *   is fetched over the network to render this map; a level editor should work on a
 *   plane.
 * - **No topology plugin.** A level has no parcels, so `gameMapPreset` simply does
 *   not install `@blaeu/plugin-topology` — and JSTS, the bulk of that plugin's
 *   weight, is not in this bundle. You do not pay for what you do not use, which is
 *   only true because topology was a plugin rather than a core feature.
 * - **A custom CRS, registered at runtime.** A game world is a plane in arbitrary
 *   units. `worldCrsPlugin` calls `crs.register()` with it and makes it the working
 *   CRS — after which every planar facility the kernel already had (snapping, grid
 *   quantisation, distance, area, the coordinate readout) is operating in *tiles*,
 *   with not one line of the kernel changed. They were never written against the
 *   Earth; they were written against `crs.working`.
 * - **A custom layer type.** The grid you can see is a `tile-grid` layer, a category
 *   the core has never heard of, registered by the preset in one file.
 *
 * ## The one thing to take away
 *
 * Snapping is **not** something the place tool calls. It is interaction middleware:
 * it rewrites `ctx.lngLat` at priority 100, before any tool sees the event. The
 * place tool — fifteen lines, in `preset-game/src/plugins/entity.ts` — reads
 * `ctx.lngLat` and has never heard of the grid. The readout at the bottom of the
 * screen shows both numbers so you can watch it happen: *pointer* is where your
 * mouse is, *snapped* is what the tool actually receives.
 *
 * That indirection is why a tool written by a stranger next year snaps for free.
 */

import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'

import {
  createBlaeuMap,
  RemoveFeaturesCommand,
  type Disposable,
  type FeatureId,
  type BlaeuFeature,
} from '@blaeu/core'
import { BOX_TOOL } from '@blaeu/plugin-select'
import {
  DEFAULT_COLLECTION,
  DEFAULT_ZONE_COLLECTION,
  ENTITY_PROPERTY,
  PLACE_TOOL,
  gameMapPreset,
  scatterAround,
  type EntityType,
  type WorldXY,
} from '@blaeu/preset-game'

/** One tile, in world units. Not metres — there is no Earth under this map. */
const GRID = 32

/** The polygon tool the draw plugin registers. Zones are the designer's own regions. */
const ZONE_TOOL = 'draw:polygon'

/**
 * The palette.
 *
 * This *is* the domain model of a game map, and it is four lines long — which is
 * the argument. The cadastre preset's domain model is `ada`/`parsel`/`malik`. The
 * kernel knows about neither, and could not name either one if you asked it.
 */
const ENTITIES: readonly EntityType[] = [
  { id: 'tree', label: 'Tree', icon: '🌲', size: 10 },
  { id: 'rock', label: 'Rock', icon: '🪨', size: 8 },
  { id: 'building', label: 'Building', icon: '🏠', size: 26 },
  { id: 'spawn', label: 'Spawn', icon: '🚩', size: 14 },
]

const map = await createBlaeuMap({
  container: '#map',
  preset: gameMapPreset({
    gridSize: GRID,
    entities: ENTITIES,
    // The playable rectangle, in world units — 64 × 64 tiles.
    bounds: [-1024, -1024, 1024, 1024],
    // The preset ships framework-free chrome (`@blaeu/plugin-ui`), and a real
    // product would probably keep it. It is off here to make a point: everything
    // below is driven through the public API from plain HTML, exactly as a game
    // embedding BlaeuMap in its own React/Svelte editor chrome would drive it.
    // Nothing in the kernel requires the UI plugin to exist.
    ui: false,
  }),
})

/*
 * The world plane. `map.plugin('game-world')` is typed with no cast, because the
 * preset augmented `BlaeuPluginRegistry` — a typo in the id here is a compile error,
 * not an `undefined` at runtime.
 */
const world = map.plugin('game-world')
const entity = map.plugin('game-entity')
const select = map.plugin('select')
const history = map.plugin('history')

/** Everything this page subscribes to. Core invariant 5: every subscription is disposed. */
const disposables: Disposable[] = []

/* ========================================================================== */
/* Camera                                                                     */
/* ========================================================================== */

// Open on a 20-tile window rather than the whole world: a 64-tile grid seen at once
// is a grey wash, and an example that opens on one has taught the reader nothing.
map.renderer.fitBounds(world.boundsToLngLat([-320, -320, 320, 320]), { padding: 24 })

/* ========================================================================== */
/* Palette — click to place, everything snaps to the grid                     */
/* ========================================================================== */

const palette = byId<HTMLDivElement>('palette')

for (const type of entity.types) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'chip'
  button.dataset['entity'] = type.id
  button.innerHTML = `<span class="glyph">${type.icon}</span><span>${type.label}</span>`
  button.addEventListener('click', () => {
    // Two calls, and that is the whole of "placing things". `setCurrent` picks the
    // type; the tool is what turns a click into a command. The tool then reads a
    // *snapped* pointer position it did not snap.
    entity.setCurrent(type.id)
    setMode('place')
  })
  palette.append(button)
}

/* ========================================================================== */
/* Modes                                                                      */
/* ========================================================================== */

type Mode = 'place' | 'select' | 'zone'

const MODES: readonly { id: Mode; tool: string; label: string; hint: string }[] = [
  { id: 'place', tool: PLACE_TOOL, label: 'Place', hint: 'Click to place the current entity.' },
  {
    id: 'select',
    tool: BOX_TOOL,
    label: 'Select',
    hint: 'Drag a box. Shift adds. Delete removes the selection.',
  },
  {
    id: 'zone',
    tool: ZONE_TOOL,
    label: 'Zone',
    hint: 'Click to add vertices, double-click to close the polygon.',
  },
]

const modes = byId<HTMLDivElement>('modes')
const status = byId<HTMLSpanElement>('status')

for (const mode of MODES) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn mode'
  button.dataset['mode'] = mode.id
  button.textContent = mode.label
  button.addEventListener('click', () => setMode(mode.id))
  modes.append(button)
}

function setMode(id: Mode): void {
  const mode = MODES.find((candidate) => candidate.id === id)
  if (!mode) return

  // The kernel owns tool activation, so the page never has to know which plugin a
  // tool came from. `select:box` is the select plugin's; `entity:place` is the
  // preset's; `draw:polygon` is the draw plugin's. To `map.tools` they are the same
  // kind of thing, and only one can be active.
  map.tools.activate(mode.tool)

  for (const button of modes.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset['mode'] === id)
  }
  for (const chip of palette.querySelectorAll('button')) {
    chip.classList.toggle('active', id === 'place' && chip.dataset['entity'] === entity.current?.id)
  }
  status.textContent = mode.hint
}

// The draw plugin activates `draw:polygon` in its own setup (its `defaultMode`), so
// something has to have the last word about what the editor opens in. That is the
// application's job, not the preset's.
setMode('place')

/* ========================================================================== */
/* Procedural generation — a commit-middleware hook                           */
/* ========================================================================== */

/*
 * `scatterAround` returns an `EntityGenerator`: a function from "what was placed" to
 * "what else should exist". The entity plugin runs it inside the **commit pipeline**,
 * which is the same seam the cadastre preset uses to ask a server whether a parcel
 * overlaps a neighbour's. Three consequences, none of which this page had to build:
 *
 *  1. Generated features are validated by the same rules as hand-placed ones — a tree
 *     scattered outside the world bounds is rejected by the rule that would have
 *     rejected a designer who clicked there.
 *  2. They land in the *same command*, so one Ctrl+Z removes the building and its six
 *     trees together. A level designer will accept nothing else.
 *  3. A generator may be async. Asking a server for a room layout is a reasonable
 *     thing to write, and the commit pipeline is async precisely so it can be. (The
 *     interaction pipeline is not — core invariant 4.)
 *
 * The scatter is deterministic, seeded from the trigger's position: a level editor
 * whose output changes on every re-run produces levels that cannot be diffed or
 * reproduced from a bug report.
 */
const GENERATORS = [
  scatterAround({ type: 'tree', count: 5, radius: 3 * GRID, around: ['building'] }),
  scatterAround({ type: 'rock', count: 2, radius: 2 * GRID, around: ['building'], seed: 0x5eed }),
]

let scatter: Disposable[] = []

function setScatter(on: boolean): void {
  // `onGenerate` hands back a Disposable, like every subscription in BlaeuMap
  // (core invariant 5). Disposing it is the *entire* implementation of turning
  // procedural generation off — there is no flag to check and no branch in the tool.
  for (const generator of scatter) generator.dispose()
  scatter = on ? GENERATORS.map((generator) => entity.onGenerate(generator)) : []
}

const generateToggle = byId<HTMLInputElement>('generate')
generateToggle.addEventListener('change', () => setScatter(generateToggle.checked))
setScatter(generateToggle.checked)

/* ========================================================================== */
/* Delete + undo/redo                                                         */
/* ========================================================================== */

const deleteButton = byId<HTMLButtonElement>('delete')
const undoButton = byId<HTMLButtonElement>('undo')
const redoButton = byId<HTMLButtonElement>('redo')

function deleteSelection(): void {
  const ids: readonly FeatureId[] = [...select.selected]
  if (ids.length === 0) return

  // One command, therefore one undo step — and the history plugin has never heard of
  // entities, zones, or this page. It knows only that a `Command` was committed and
  // that a `Command` can be undone. That is the whole of why undo works across
  // plugins that have never heard of each other. A durable delete is a `commit`, fired
  // and forgotten so this handler stays sync.
  void map.commands.commit(new RemoveFeaturesCommand(ids, { label: `Delete ${ids.length}` }))
  select.clear()
}

deleteButton.addEventListener('click', deleteSelection)
undoButton.addEventListener('click', () => history.undo())
redoButton.addEventListener('click', () => history.redo())

// Ctrl/Cmd+Z is already bound by the history plugin, on the map container. Delete is
// ours, because "delete" means something different in every application.
const onKeyDown = (event: KeyboardEvent): void => {
  if (event.key !== 'Delete' && event.key !== 'Backspace') return
  if (select.selected.size === 0) return
  event.preventDefault()
  deleteSelection()
}
window.addEventListener('keydown', onKeyDown)
disposables.push({ dispose: () => window.removeEventListener('keydown', onKeyDown) })

disposables.push(
  history.onChange(() => {
    undoButton.disabled = !history.canUndo
    redoButton.disabled = !history.canRedo
    undoButton.title = history.undoLabel ?? 'Nothing to undo'
    redoButton.title = history.redoLabel ?? 'Nothing to redo'
  }),
)

/* ========================================================================== */
/* Readout — watch the snap middleware rewrite the pointer                    */
/* ========================================================================== */

const rawOut = byId<HTMLElement>('raw')
const snappedOut = byId<HTMLElement>('snapped')
const kindOut = byId<HTMLElement>('snapkind')

/*
 * Interaction middleware, registered at priority **-100** — below the snap plugin's
 * 100, so it runs *after* snapping and sees the rewritten position. Higher priority
 * runs first; a middleware that wants to override the snap registers above it.
 *
 * Note what this is not: it is not a `pointermove` DOM listener bolted onto the
 * canvas. It sits in the same pipeline as the snapping it is reporting on, which is
 * why it can show both numbers at once — `ctx.rawLngLat` is the untouched pointer,
 * `ctx.lngLat` is what every tool downstream will believe.
 *
 * Synchronous by contract. This runs at up to 120 Hz.
 */
disposables.push(
  map.interaction.use(
    (ctx, next) => {
      if (ctx.kind === 'pointermove') {
        rawOut.textContent = formatXY(world.toWorld(ctx.rawLngLat))
        snappedOut.textContent = formatXY(world.toWorld(ctx.lngLat))

        const kind = ctx.snap?.candidate.kind
        kindOut.textContent = kind ? `snapped to ${kind}` : 'no snap'
        kindOut.classList.toggle('on', kind !== undefined)
      }
      next()
    },
    { id: 'example:readout', priority: -100 },
  ),
)

/* ========================================================================== */
/* Stats, rejections, export                                                  */
/* ========================================================================== */

const entityStat = byId<HTMLElement>('stat-entities')
const zoneStat = byId<HTMLElement>('stat-zones')
const selectedStat = byId<HTMLElement>('stat-selected')

function refreshStats(): void {
  entityStat.textContent = String(map.store.collection(DEFAULT_COLLECTION).size)
  zoneStat.textContent = String(map.store.collection(DEFAULT_ZONE_COLLECTION).size)
  selectedStat.textContent = String(select.selected.size)
  deleteButton.disabled = select.selected.size === 0
}

disposables.push(map.events.on('feature:added', refreshStats))
disposables.push(map.events.on('feature:removed', refreshStats))
disposables.push(select.onChange(refreshStats))
refreshStats()

// A validation rule can veto a placement, and the entity plugin says so rather than
// dropping the click on the floor. `boundsSeverity` is `'error'` by default: off the
// map is off the map.
disposables.push(
  map.events.on('entity:rejected', (event) => {
    status.textContent = `Rejected: ${event.payload.reason}`
    status.classList.add('warn')
    window.setTimeout(() => status.classList.remove('warn'), 1200)
  }),
)

/*
 * Export, and the one place a level editor must be careful.
 *
 * The store is WGS84 — core invariant 3, no exceptions, because it is what lets the
 * spatial index, GeoJSON export and every plugin ever written agree on what a
 * coordinate *is*. But a tree at world (128, 96) is stored at 0.00128°E, 0.00096°N,
 * which is a spot in the Gulf of Guinea where there is no tree. Those degrees are an
 * implementation detail of the CRS trick, not geography.
 *
 * So a level file is written through `world.toWorld()`, never as raw GeoJSON. Dump
 * the store straight to disk and you have a file that validates and lies.
 */
const exportOut = byId<HTMLPreElement>('export-out')

byId<HTMLButtonElement>('export').addEventListener('click', () => {
  const level = {
    grid: world.gridSize,
    bounds: world.bounds,
    entities: map.store
      .collection(DEFAULT_COLLECTION)
      .all()
      .map((feature) => {
        const [x, y] = world.toWorld(pointOf(feature))
        return { type: String(feature.properties[ENTITY_PROPERTY] ?? '?'), x, y }
      }),
  }
  exportOut.hidden = false
  exportOut.textContent = JSON.stringify(level, null, 2)
})

/* ========================================================================== */
/* Teardown                                                                   */
/* ========================================================================== */

// A page that is about to be closed does not, strictly, need to tidy up. It is here
// because an example is read as a template, and the habit is the invariant: every
// subscription hands back a Disposable, and something owns it. `map.destroy()` tears
// down every plugin, layer, source and listener the kernel created.
window.addEventListener('beforeunload', () => {
  for (const item of disposables) item.dispose()
  for (const item of scatter) item.dispose()
  void map.destroy()
})

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`[example] #${id} is missing from index.html`)
  return found as T
}

/** World units, rounded. The designer thinks in tiles; `GAME:WORLD` lets the map agree. */
function formatXY(xy: WorldXY): string {
  return `${Math.round(xy[0])}, ${Math.round(xy[1])}`
}

function pointOf(feature: BlaeuFeature): readonly [number, number] {
  if (feature.geometry.type !== 'Point') return [0, 0]
  const [lng, lat] = feature.geometry.coordinates
  return [lng ?? 0, lat ?? 0]
}
