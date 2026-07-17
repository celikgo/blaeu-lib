/**
 * BlaeuMap · Kadastro / Parsel Düzenleme
 * ======================================
 *
 * A cadastral parcel editor, built by *configuring* the kernel rather than by
 * extending it. Read this file top to bottom and you should finish it understanding
 * the architecture; the four things worth carrying away are:
 *
 * 1. **A preset is the product.** `cadastrePreset({ crs: 'EPSG:5254', locale: 'tr' })`
 *    is plain data: which plugins, with which options, which validation rules at which
 *    severities, which layers, which theme, which words. Nothing below subclasses
 *    anything. The Turkish UI, the millimetre readout, the topological editing and the
 *    parcel schema are all *decisions in that preset*, not features of this app.
 *
 * 2. **Snapping is not something the draw tool calls.** It is interaction middleware.
 *    It rewrites `ctx.lngLat` before any tool sees the pointer event, so `plugin-draw`
 *    — which has never heard of `plugin-snap` and does not import it — reads a
 *    position that is already exactly on the neighbouring parcel's corner. Same for
 *    the edit tool. Same for a tool a stranger writes next year.
 *
 * 3. **The store is WGS84; the maths is not.** Every survey-grade number — area,
 *    length, bearing, topology — projects into the working CRS (TUREF/TM30, metres),
 *    computes there, and projects back. Sphere maths is not survey maths.
 *
 * 4. **Everything that changes state is a Command.** Which is why undo works across
 *    plugins that have never heard of each other, including the little one this file
 *    defines itself (see `commit.ts`).
 */

import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'

import type { StyleSpecification } from 'maplibre-gl'

import {
  createBlaeuMap,
  BlaeuCrsService,
  MapLibreRenderer,
  type FeatureId,
  type BlaeuFeature,
  type BlaeuMap,
  type InteractionContext,
  type ValidationIssue,
} from '@blaeu/core'
import {
  cadastrePreset,
  BUILDINGS_COLLECTION,
  CADASTRE_COLORS,
  PARCELS_COLLECTION,
} from '@blaeu/preset-cadastre'

import { commitAdd, draft, reconcile } from './commit.js'
import {
  createActions,
  createAttributePanel,
  createLivePanel,
  createParcelTable,
  formatArea,
} from './panel.js'
import {
  BUILDING_SEEDS,
  OVERLAPPING_RING,
  PARCEL_SEEDS,
  ringToPolygon,
  SELF_INTERSECTING_RING,
  seedBounds,
  seedCentre,
} from './seed.js'

/** TUREF / TM30 — the 3° belt centred on 30°E. Eskişehir sits in it; İzmir does not. */
const CRS = 'EPSG:5254'
/** Millimetres. What a Turkish cadastral coordinate schedule is printed to. */
const PRECISION = 3

/* ========================================================================= */
/* 1. The basemap                                                            */
/* ========================================================================= */

/**
 * Paper, and nothing else.
 *
 * A cadastral map is read by following one line, and every saturated pixel that is
 * not that line is competing with it. So: no imagery, no street map — a survey sheet.
 * Point `basemap` at your orthophoto (see `paleRasterBasemap()` in the preset) and it
 * will be desaturated and faded *behind* the boundaries, for the same reason.
 *
 * The `glyphs` endpoint is not optional: the preset's parcel-label layer draws
 * "102/7" with a `symbol` layer, and MapLibre refuses a text layer in a style with
 * nowhere to fetch a font from. This is the one thing here that touches the network.
 */
const basemap: StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [
    { id: 'paper', type: 'background', paint: { 'background-color': CADASTRE_COLORS.surface } },
  ],
}

/* ========================================================================= */
/* 2. The map                                                                */
/* ========================================================================= */

/**
 * The seed data is projected *before* the map exists, so build a CRS service to do it
 * with. `BlaeuCrsService` is a pure object — no DOM, no map, no globals — which is
 * exactly why it is exported: a server-side importer, a test, and this file all need
 * the same projection maths, and none of them should have to construct a map to get it.
 */
const crs = new BlaeuCrsService({ working: CRS, display: 'projected', precision: PRECISION })

const map: BlaeuMap = await createBlaeuMap({
  container: '#map',
  preset: cadastrePreset({ crs: CRS, locale: 'tr' }),

  // ── DX friction, reported rather than papered over ───────────────────────────
  // The kernel constructs its own `MapLibreRenderer()` with no arguments when you do
  // not pass one, which means (a) `theme.basemap` — which the preset sets — never
  // reaches MapLibre, and (b) neither does `config.interaction`, so the preset's
  // `doubleClickZoom: false` (double-click *closes the ring*; it must not also zoom)
  // is silently dropped. Constructing the renderer ourselves is the only way to honour
  // either, and it forces this file to restate a decision the preset already made.
  renderer: new MapLibreRenderer({
    style: basemap,
    interaction: { doubleClickZoom: false },
    mapOptions: { maxZoom: 24, attributionControl: false },
  }),

  camera: { center: seedCentre(crs), zoom: 17.5 },
})

// A hand-hold for the console: `map.plugin('history').undo()`, `map.debug.snapshot()`.
// An example is also a place to poke at the thing.
;(globalThis as unknown as { map: BlaeuMap }).map = map

/* ========================================================================= */
/* 3. The seed data — through the commit gate, like everything else          */
/* ========================================================================= */

/**
 * Note what the seeds do *not* carry: a `yuzolcumu`. It is stamped on the way in by
 * the preset's `deriveAreaMiddleware`, which `commitAdd` runs. Seed data that typed
 * its own area would be asserting a number its corners might not agree with — which is
 * the exact failure this preset exists to make impossible.
 */
await commitAdd(
  map,
  PARCELS_COLLECTION,
  PARCEL_SEEDS.map((seed) =>
    draft(PARCELS_COLLECTION, ringToPolygon(crs, seed.ring), { ...seed.properties }, seed.id),
  ),
  'Parseller yüklendi',
)

await commitAdd(
  map,
  BUILDINGS_COLLECTION,
  BUILDING_SEEDS.map((seed) =>
    draft(BUILDINGS_COLLECTION, ringToPolygon(crs, seed.ring), { ...seed.properties }, seed.id),
  ),
  'Yapılar yüklendi',
)

// Loading a document is not an edit. Ctrl+Z should not be able to undo the world.
map.plugin('history').clear()
map.renderer.fitBounds(seedBounds(crs), { padding: 72, duration: 0 })

/* ========================================================================= */
/* 4. The panel                                                              */
/* ========================================================================= */

const live = createLivePanel(map)
const attributes = createAttributePanel(map)
const table = createParcelTable(map, (id) => map.plugin('select').select(id))

createActions({
  selectMode: () => map.tools.activate('select:single'),
  drawParcel: () => map.plugin('draw').start('polygon'),
  editCorners: () => {
    const [first] = map.plugin('select').selected
    if (first === undefined) {
      live.flash('Önce bir parsel seçin, sonra köşelerini düzenleyin.')
      map.tools.activate('select:single')
      return
    }
    // `edit()` shows the handles and activates `edit:vertex` — one call, because the
    // plugin owns what "editing" means, not this app.
    map.plugin('edit').edit(first)
  },
  trySelfIntersecting: () => void attemptInvalid(SELF_INTERSECTING_RING, 'Kendini kesen parsel'),
  tryOverlapping: () => void attemptInvalid(OVERLAPPING_RING, 'Çakışan parsel'),
  validateAll: () => void validateEverything(),
})

/* ========================================================================= */
/* 5. Snapping and the shared-corner readout                                 */
/* ========================================================================= */

/**
 * The snap engine announces its winner. The hint is already localised — the snap
 * plugin ships `snap.vertex` etc. in Turkish, and a preset could rename them to
 * "Parsel köşesi" without the plugin containing a word of Turkish.
 */
map.events.on('snap:changed', (event) => {
  const candidate = event.payload.result?.candidate
  live.setSnap(candidate === undefined ? null : (candidate.hint ?? candidate.kind))
})

/**
 * A middleware of our own, to answer one question on every pointer move: *is the point
 * under the cursor a corner that more than one parcel owns?*
 *
 * Priority 10 puts it **after** the snap engine (which sits at 100), so `ctx.lngLat`
 * has already been rewritten to the exact corner by the time we read it. Asking the
 * topology index about the raw pointer position would answer "no" for a cursor two
 * pixels off the node, which is the same as never answering yes.
 *
 * Synchronous, allocation-light, and it calls `next()` — the three rules of the
 * interaction pipeline (core invariant 4).
 */
map.interaction.use(
  (ctx: InteractionContext, next: () => void) => {
    if (ctx.kind === 'pointermove') {
      const ids = map.store.topology.featuresAt(ctx.lngLat)
      const features = ids
        .map((id) => map.store.find(id))
        .filter(
          (f): f is BlaeuFeature => f !== undefined && f.meta.collection === PARCELS_COLLECTION,
        )
      live.setSharedCorner(features.length > 0 ? features : null)
    }
    next()
  },
  { id: 'example:shared-corner', priority: 10 },
)

/* ========================================================================= */
/* 6. The money shot: one corner, three parcels, one command                 */
/* ========================================================================= */

/**
 * `edit:vertex-move` carries **every** vertex that moved. With `topological: true` —
 * which the cadastre preset sets, and which is the single most important line in that
 * package — the edit plugin looks the dragged corner up in the topology index, finds
 * every feature carrying a vertex on that same millimetre, and moves them all in one
 * `MoveVerticesCommand`.
 *
 * So: one drag, one command, one Ctrl+Z, and three parcels that still share a
 * boundary. The alternative — moving only the parcel you happen to have selected —
 * does not produce a rendering artefact. It produces a strip of land with no owner.
 */
map.events.on('edit:vertex-move', (event) => {
  const parcels = new Set(event.payload.refs.map((ref) => ref.feature))
  if (parcels.size < 2) return
  live.flash(
    `Ortak köşe taşındı — ${parcels.size} parsel birlikte güncellendi (tek komut, tek geri alma).`,
  )
})

/* ========================================================================= */
/* 7. Keeping the derived state honest                                       */
/* ========================================================================= */

/**
 * Any change to a parcel — a drag, an undo, an attribute edit — redraws the table
 * *immediately* (that is where you watch three areas move at once) and schedules the
 * expensive work.
 *
 * The split matters. Re-deriving the area is cheap: it is one projection sandwich per
 * parcel, and it can run at pointer frequency. Re-validating is not: `plugin-topology`
 * runs JSTS overlay operations against every neighbour, and doing that on every frame
 * of a drag would make the drag stutter. So validation is debounced to the pause the
 * surveyor takes when they let go of the mouse — which is also when they want the
 * answer.
 */
let pending: number | undefined
let reconciling = false

map.store.onChange((change) => {
  if (change.collection !== PARCELS_COLLECTION) return

  table.refresh()
  attributes.show(selectedParcel())

  // Our own derived-area write lands here too. Without this guard it would schedule a
  // reconcile of itself — terminating (the middleware is idempotent) but pointless.
  if (reconciling) return

  window.clearTimeout(pending)
  pending = window.setTimeout(() => void reconcileParcels(), 150)
})

async function reconcileParcels(): Promise<void> {
  reconciling = true
  try {
    const parcels = map.store.collection(PARCELS_COLLECTION).all()
    const rejected = await reconcile(map, parcels)

    if (rejected !== undefined) {
      // The write already happened — the edit plugin dispatched it, and the commit
      // pipeline was not in that path. Post-hoc, the honest thing is to say so, name
      // the rule, and point at the undo the user already knows how to press.
      live.flash('Düzenleme kuralları ihlal ediyor — Ctrl+Z ile geri alabilirsiniz.')
    }
    table.refresh()
    attributes.show(selectedParcel())
  } finally {
    reconciling = false
  }
}

/* ========================================================================= */
/* 8. Selection → the attribute record                                       */
/* ========================================================================= */

map.events.on('select:changed', (event) => {
  table.setSelected(event.payload.selected)
  attributes.show(selectedParcel())

  const feature = selectedParcel()
  if (feature !== undefined) {
    // The area a surveyor reads out loud, from the geometry, in the plane.
    map.plugin('ui').status.set('parcel', `Seçili: ${formatArea(map, feature.geometry)}`)
  } else {
    map.plugin('ui').status.clear('parcel')
  }
})

function selectedParcel(): BlaeuFeature | undefined {
  const [id] = map.plugin('select').selected
  if (id === undefined) return undefined
  const feature = map.store.find(id)
  return feature?.meta.collection === PARCELS_COLLECTION ? feature : undefined
}

/* ========================================================================= */
/* 9. Validation, seen from the user's side                                  */
/* ========================================================================= */

/**
 * `validation:failed` is emitted by the commit pipeline's validation middleware — the
 * kernel's, not ours — every time a rule has something to say, whether or not it
 * blocked the write. (Warnings ride along with errors: a UI wants to say "sliver,
 * 0.4 m²" even when the save succeeds.)
 *
 * The map's own issue panel, top-right, is already listening to this and already flies
 * the camera to `issue.at` when you click an entry. We mirror it into the side panel
 * because on this page the error *is* the demo.
 */
map.events.on('validation:failed', (event) => {
  live.setIssues(event.payload.issues, headline(event.payload.issues))
})

function headline(issues: readonly ValidationIssue[]): string {
  const errors = issues.filter((issue) => issue.severity === 'error').length
  return errors > 0
    ? `Kayıt reddedildi — ${errors} hata. Geçersiz geometri, bir an için bile depoya girmez.`
    : `${issues.length} uyarı.`
}

/**
 * Try to store a parcel the rules will refuse.
 *
 * Nothing is dispatched: no feature, no history entry, nothing to undo. The parcel
 * never exists. That is the correct behaviour for a land registry — invalid geometry
 * should not exist even transiently, because something always exports it — and it is
 * the reason validation lives in the *commit* pipeline rather than in a save button.
 */
async function attemptInvalid(
  ring: readonly (readonly [number, number])[],
  label: string,
): Promise<void> {
  const id = `sinama-${label === 'Çakışan parsel' ? 'cakisma' : 'kesisme'}`
  const result = await commitAdd(
    map,
    PARCELS_COLLECTION,
    [
      draft(
        PARCELS_COLLECTION,
        ringToPolygon(crs, ring),
        { ada: '102', parsel: '99', malik: 'Sınama' },
        id,
      ),
    ],
    label,
  )

  if (result.ok) {
    // Reachable only if somebody has relaxed the rules — which is a supported thing to
    // do (`cadastrePreset({ strictTopology: false })` and friends), so say so rather
    // than pretending it cannot happen.
    live.flash(`${label} kabul edildi — kurallar gevşetilmiş olmalı.`)
    return
  }
  live.flash(`${label} reddedildi. Depoda hiçbir iz yok; geri alınacak bir şey de yok.`)
}

/** "Validate the whole layer" — how a surveyor checks a batch import before signing it. */
async function validateEverything(): Promise<void> {
  const issues = await map.plugin('topology').validate(idsIn(PARCELS_COLLECTION))
  live.setIssues(
    issues,
    issues.length === 0 ? 'Bütün parseller kurallara uygun.' : headline(issues),
  )
}

function idsIn(collection: string): readonly FeatureId[] {
  return map.store
    .collection(collection)
    .all()
    .map((feature) => feature.id)
}

/* ========================================================================= */
/* 10. Where to start                                                        */
/* ========================================================================= */

map.tools.activate('select:single')
map.plugin('ui').status.set('hint', map.i18n.t('cadastre.hint.topologicalEdit'))

// The bottom-left readout inside the map shows `Y=458123.456  X=4421987.123`: the
// *snapped* pointer position, in the working CRS, to the millimetre. It is the string
// a surveyor types back into a coordinate schedule, and it comes from `crs.format()`
// honouring `config.crs.display: 'projected'` — a preset decision, not a UI one. Two
// places deciding what a coordinate looks like is one place too many.
map.plugin('ui').status.set('crs', `${map.crs.working.name} · ${map.crs.working.code} · mm`)
