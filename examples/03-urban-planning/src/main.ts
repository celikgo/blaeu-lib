/**
 * BlaeuMap — example 03: urban planning / zoning.
 *
 * Read this file top to bottom and you should finish it understanding the
 * architecture. Four things are being demonstrated, and only one of them is about
 * zoning:
 *
 * 1. **A preset is data.** `urbanPlanningPreset()` is a pure function returning a
 *    plain object: plugins, config, layers, validation rules, theme, i18n. This app
 *    reads its attribute forms straight off that object *before the map exists*.
 *
 * 2. **N categories, one layer.** The zoning fill is a single MapLibre `match`
 *    expression over `properties.zoning`. Changing a polygon's category is a
 *    property write; the recolour is a consequence, not a code path.
 *
 * 3. **Severity is a domain decision.** The topology plugin *finds* an overlap. Only
 *    the preset knows whether an overlap is a dispute (cadastre: `error`, the write
 *    is refused) or a thought (planning: `warning`, the write lands and is flagged).
 *    Same plugin, same rule id, one inverted line.
 *
 * 4. **Snapping is middleware.** Nothing below asks for a snap. The polygon tool
 *    reads `ctx.lngLat`, which the snap plugin already rewrote onto the 5 m planning
 *    grid or onto a neighbour's corner. The draw plugin does not import the snap
 *    plugin and has never heard of it — which is why a tool a stranger writes next
 *    year snaps for free.
 */

import 'maplibre-gl/dist/maplibre-gl.css'
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl'

import {
  AddFeaturesCommand,
  MapLibreRenderer,
  RemoveFeaturesCommand,
  SetPropertiesCommand,
  createBlaeuMap,
  type Bbox,
  type FeatureId,
  type FeatureInput,
  type BlaeuFeature,
  type BlaeuMap,
  type Json,
  type LngLat,
  type Polygon,
  type ProjectedXY,
  type ValidationIssue,
} from '@blaeu/core'
import { SINGLE_TOOL } from '@blaeu/plugin-select'
import { RULE_IDS } from '@blaeu/plugin-topology'
import {
  DEFAULT_ZONING_CATEGORIES,
  FIELD,
  ZONING_FILL_LAYER,
  urbanPlanningPreset,
  zoningFillColour,
  type AttributeField,
  type AttributeSchemas,
  type ScenarioComparison,
  type ZoningCategory,
} from '@blaeu/preset-urban'

/* ================================================================== *
 * 1. The preset — constructed, and read, before any map exists.
 * ================================================================== */

const COLLECTION = 'zoning'

/**
 * `locale: 'en'` only because this page is written in English; the preset's own
 * default is `'tr'`, and the domain words stay Turkish either way — a planner asks
 * for the *emsal*, not for the "floor area ratio", whichever language the chrome is
 * in.
 *
 * Everything else is left at the preset's defaults on purpose: EPSG:5254 (TUREF/TM33
 * — areas in real metres over central Türkiye), a 5 m planning grid, a 20 px snap
 * tolerance, `topologySeverity: 'warning'`. Each of those is an option a municipality
 * would retune without forking, and the point of the example is that you do not have
 * to.
 */
const preset = urbanPlanningPreset({ locale: 'en' })

/** The legend. Everything on this page — colours, forms, area report — is derived from it. */
const categories: readonly ZoningCategory[] = DEFAULT_ZONING_CATEGORIES

/**
 * The attribute forms, read out of the preset **as data**.
 *
 * `Preset` has no `attributes` field and should not grow one for a single domain, so
 * the preset parks its forms on `LayerSpec.config` — the sanctioned per-layer bag.
 * That means a host app can render a plan's attribute form without constructing a
 * map at all, which is exactly what "a preset is data" buys you.
 *
 * The cast is the one wart: `config` is `Record<string, unknown>`, so the preset's
 * own typed payload comes back untyped. See the friction notes in the README of this
 * example's PR.
 */
const schemas = (preset.layers?.find((layer) => layer.id === ZONING_FILL_LAYER)?.config?.[
  'attributes'
] ?? {}) as AttributeSchemas

/* ================================================================== *
 * 2. The map.
 * ================================================================== */

/**
 * A deliberately drab basemap.
 *
 * The zoning fill is doing the talking: five saturated legend colours over a
 * saturated basemap is a map nobody can read. So the raster is desaturated and
 * dimmed, and the plan sits on top of it.
 *
 * The kernel's default is a *blank* style, which is the honest default for a library
 * (a default that reaches for the network fails slowly on a municipal intranet).
 * Choosing the basemap is a deployment decision, so it is made here, in the host app,
 * rather than baked into the published preset.
 */
const basemap: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-saturation': -0.9, 'raster-opacity': 0.55 },
    },
  ],
}

const map: BlaeuMap = await createBlaeuMap({
  container: '#map',
  preset,

  /*
   * The renderer is constructed by hand for two reasons: the basemap above, and
   * `interaction`. The preset asks for `doubleClickZoom: false` — double-click closes
   * a ring in every plan-drawing tool a planner has ever used, and it cannot also zoom
   * — but the kernel builds its default `MapLibreRenderer()` with no arguments, so
   * that config never reaches MapLibre unless the host app carries it across. (Friction
   * note: this is a DX bug in the library, not a design decision. See the PR notes.)
   */
  renderer: new MapLibreRenderer({
    style: basemap,
    interaction: { doubleClickZoom: false },
  }),

  camera: { center: [32.8541, 39.9208], zoom: 16 },
})

/*
 * Invariant 6: the one escape hatch, used deliberately and greppably. Everything the
 * library wraps, use the library for. MapLibre's own chrome is not something we wrap,
 * and the alternative to reaching for it is forking.
 */
const native = map.renderer.getNative<MapLibreMap>()
native.addControl(new maplibregl.NavigationControl(), 'top-right')
native.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right')

/* ================================================================== *
 * 3. Seed a block of plan, built in metres.
 * ================================================================== */

/**
 * Invariant 3, in six lines.
 *
 * The store is WGS84 and always will be — but *nothing about a city block is
 * expressed in degrees*. A block is 120 m by 90 m with a 24 m road between it and its
 * neighbour. So the seed is laid out in the projected working CRS, in metres, on the
 * plane where those numbers mean what they say, and only then projected back to
 * lng/lat for the store.
 *
 * Do this the other way round — pick degrees and hope — and the blocks are subtly
 * trapezoidal, the areas are wrong, and nobody notices until a council asks why the
 * green space total moved.
 */
function seedZones(): readonly FeatureInput[] {
  const plane = map.crs.working
  const [ox, oy] = plane.forward([32.851, 39.9185])

  const BLOCK_W = 120
  const BLOCK_H = 90
  const ROAD = 24

  /** code, KAKS (emsal), gabari — plausible district-plan values, not law. */
  const plan: readonly (readonly [string, number | null, number | null])[] = [
    ['K', 1.2, 15.5],
    ['K', 1.5, 15.5],
    ['T', 2.0, 18.5],
    ['YA', null, null],
    ['D', 1.0, 12.5],
    ['S', 1.0, 12.5],
  ]

  return plan.map(([code, kaks, gabari], i) => {
    const col = i % 3
    const row = Math.floor(i / 3)
    const x0 = ox + col * (BLOCK_W + ROAD)
    const y0 = oy + row * (BLOCK_H + ROAD)

    const ring: readonly ProjectedXY[] = [
      [x0, y0],
      [x0 + BLOCK_W, y0],
      [x0 + BLOCK_W, y0 + BLOCK_H],
      [x0, y0 + BLOCK_H],
      [x0, y0], // closed: first === last. `closedRings` is an *error* even in this preset.
    ]

    const geometry: Polygon = {
      type: 'Polygon',
      coordinates: [ring.map((xy) => [...plane.inverse(xy)])],
    }

    const properties: Record<string, Json> = { [FIELD.zoning]: code }
    if (kaks !== null) properties[FIELD.far] = kaks
    if (gabari !== null) properties[FIELD.height] = gabari

    return { geometry, properties, meta: { source: 'seed' } }
  })
}

/*
 * Every mutation is a Command (invariant 2) — including the seed. There is no
 * back door into the store, and the fact that the seed has to use the front door is
 * the reason a plugin written next year can undo it.
 *
 * The history is then cleared: the plan as it loads is the floor, not a step the user
 * can accidentally Ctrl-Z their way underneath.
 */
map.commands.dispatch(new AddFeaturesCommand(COLLECTION, seedZones(), { label: 'Load plan' }))
map.plugin('history').clear()
map.renderer.fitBounds(boundsOf(map.store.collection(COLLECTION).all()), { padding: 64 })

/* ================================================================== *
 * 4. The claim in the masthead, read from the live registry.
 * ================================================================== */

/*
 * Not a hardcoded string. The severity is read back out of the validation registry the
 * preset populated, so the page cannot claim "warning" while the code says otherwise.
 * `RULE_IDS.overlap` is the *plugin's* id — the same constant the cadastre preset
 * registers `severity: 'error'` under.
 */
const overlapRule = map.validation.list().find((rule) => rule.id === RULE_IDS.overlap)
text('overlap-severity', overlapRule?.severity ?? 'not registered')

text('fill-expression', JSON.stringify(zoningFillColour(categories, FIELD.zoning), null, 1))

/* ================================================================== *
 * 5. Tools, selection, history.
 * ================================================================== */

const select = map.plugin('select')
const history = map.plugin('history')

for (const button of document.querySelectorAll<HTMLButtonElement>('#toolbar [data-tool]')) {
  button.addEventListener('click', () => map.tools.activate(button.dataset['tool'] ?? ''))
}

/* The toolbar reflects the tool manager; it does not *own* the active tool. A plugin
 * (or a keyboard shortcut, or a preset's `defaultMode`) can activate a tool without
 * the toolbar's knowledge, and this keeps the buttons honest when it does. */
map.events.on('tool:activated', (event) => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('#toolbar [data-tool]')) {
    button.classList.toggle('btn--active', button.dataset['tool'] === event.payload.id)
  }
})

button('edit-zone').addEventListener('click', () => {
  const [id] = [...select.selected]
  if (id !== undefined) map.plugin('edit').edit(id)
})

button('delete-zone').addEventListener('click', () => {
  const ids = [...select.selected]
  if (ids.length === 0) return
  map.commands.dispatch(new RemoveFeaturesCommand(ids, { label: 'Delete zone' }))
  select.clear()
})

button('undo').addEventListener('click', () => history.undo())
button('redo').addEventListener('click', () => history.redo())

history.onChange(() => {
  const undo = button('undo')
  const redo = button('redo')
  undo.disabled = !history.canUndo
  redo.disabled = !history.canRedo
  undo.title = history.undoLabel ?? ''
  redo.title = history.redoLabel ?? ''
})

/*
 * A newly drawn zone selects itself, so the attribute form is already open on it and
 * the category dropdown is one click away. The preset stamped the default category on
 * it at draw time (`properties: () => ({ zoning: 'K' })`) — a polygon that has to be
 * drawn *and then* classified renders grey in between, and the grey flash reads as a
 * bug.
 */
map.events.on('draw:complete', (event) => {
  select.select(event.payload.feature.id)
  status('Zone drawn. Pick a category below — the fill follows the property, not a new layer.')
})

select.onChange(() => {
  renderAttributeForm()
  const one = select.selected.size === 1
  button('edit-zone').disabled = !one
  button('delete-zone').disabled = select.selected.size === 0
})

/*
 * Undo, a scenario switch and another user's sync all change the store without going
 * anywhere near the click handlers above. Redrawing from the store — rather than from
 * what we *think* we just did — is what keeps the panels correct when they do.
 *
 * The collection filter is not a micro-optimisation. Half a dozen plugins keep their
 * working state in the same store: the draw plugin rewrites `draw:preview` on every
 * pointer move, the edit plugin rewrites its vertex handles on every drag frame. An
 * unfiltered subscription here would reproject every polygon in the plan at 120 Hz and
 * rebuild the attribute form under the user's cursor while they drag a corner.
 */
map.store.onChange((change) => {
  if (change.collection !== COLLECTION) return
  renderLegend()
  renderAttributeForm()
})

/* ================================================================== *
 * 6. Legend — live areas, planar, in the working CRS.
 * ================================================================== */

function renderLegend(): void {
  const areas = new Map<string, number>()
  for (const feature of map.store.collection(COLLECTION).all()) {
    const code = codeOf(feature)
    // Planar, in EPSG:5254, in m² (invariant 3). `@turf/area` would answer a spherical
    // number that is wrong by square metres at this latitude — which is fine for a
    // heatmap and not fine for a plan a council votes on.
    areas.set(code, (areas.get(code) ?? 0) + map.crs.area(feature.geometry))
  }

  const list = el<HTMLUListElement>('legend')
  list.replaceChildren(
    ...categories.map((category) => {
      const item = document.createElement('li')
      item.innerHTML = `
        <span class="swatch" style="background:${category.color}"></span>
        <span class="legend__label">${map.i18n.t(`urban.zoning.${category.code}`)}</span>
        <span class="legend__area">${map.i18n.area(areas.get(category.code) ?? 0)}</span>`
      return item
    }),
  )
}

/* ================================================================== *
 * 7. The attribute form — derived from the legend, never hand-written.
 * ================================================================== */

function renderAttributeForm(): void {
  const form = el<HTMLFormElement>('attribute-form')
  const [id] = [...select.selected]
  const feature = id === undefined ? undefined : map.store.find(id)

  if (feature === undefined || feature.meta.collection !== COLLECTION) {
    text('attributes-subject', 'nothing selected')
    form.replaceChildren(empty('Select a zone, or draw one, to edit its plan attributes.'))
    return
  }

  const code = codeOf(feature)
  text(
    'attributes-subject',
    `${map.i18n.t(`urban.zoning.${code}`)} · ${map.i18n.area(map.crs.area(feature.geometry))}`,
  )

  // The form for *this* category. Its `max` values came from the category's own caps,
  // so a zone capped at KAKS 1.5 has a form that will not accept 2.0 — the plan
  // constrains the widget, rather than the widget having its own opinion.
  const fields = schemas[code]?.fields ?? []
  form.replaceChildren(...fields.map((field) => renderField(field, feature)))
}

function renderField(field: AttributeField, feature: BlaeuFeature): HTMLElement {
  const row = document.createElement('label')
  row.className = 'form__row'

  const label = document.createElement('span')
  label.className = 'form__label'
  label.textContent = map.i18n.t(field.labelKey)
  row.append(label)

  const current = feature.properties[field.name]

  if (field.type === 'select') {
    const input = document.createElement('select')
    for (const option of field.options ?? []) {
      const node = document.createElement('option')
      node.value = option.value
      node.textContent = map.i18n.t(option.labelKey)
      node.selected = option.value === current
      input.append(node)
    }
    // 'change', not 'input': one deliberate choice is one undo step.
    input.addEventListener('change', () => {
      write(feature.id, { [field.name]: input.value }, `Set zoning to ${input.value}`)
      status('Recoloured. One layer, one `match` expression — no layer was added or removed.')
    })
    row.append(input)
    return row
  }

  const input = document.createElement('input')
  input.type = field.type === 'number' ? 'number' : 'text'
  input.value = current === undefined || current === null ? '' : String(current)
  if (field.min !== undefined) input.min = String(field.min)
  if (field.max !== undefined) input.max = String(field.max)
  if (field.step !== undefined) input.step = String(field.step)

  input.addEventListener('change', () => {
    const raw = input.value.trim()
    // An empty field means "the plan sets no value here", and `SetPropertiesCommand`
    // deletes a key set to `undefined` rather than storing a null — which keeps the
    // exported GeoJSON free of null confetti.
    const value: Json | undefined =
      raw === '' ? undefined : field.type === 'number' ? Number(raw) : raw
    if (typeof value === 'number' && Number.isNaN(value)) return
    write(feature.id, { [field.name]: value }, 'Edit plan attributes')
  })

  row.append(input)
  if (field.unit !== undefined) {
    const unit = document.createElement('span')
    unit.className = 'form__unit'
    unit.textContent = field.unit
    row.append(unit)
  }
  if (field.max !== undefined) {
    const cap = document.createElement('span')
    cap.className = 'form__cap'
    cap.textContent = `plan cap ${field.max}`
    row.append(cap)
  }
  return row
}

/** Every attribute edit is a command, so every attribute edit is undoable. There is no other write path. */
function write(id: FeatureId, patch: Record<string, Json | undefined>, label: string): void {
  const result = map.commands.dispatch(new SetPropertiesCommand([id], patch, { label }))
  if (!result.ok) status(`Rejected: ${result.rejectedReason ?? 'a commit middleware vetoed it'}`)
}

/* ================================================================== *
 * 8. Topology — the point of the example.
 * ================================================================== */

/*
 * `validation:failed` is emitted by the kernel's commit middleware whenever a write
 * produces *any* issue — warnings included, and even when the write then succeeds. If
 * it only fired on errors, the only way to ever see a warning would be to fail, and a
 * planner would never see the overlap they just drew.
 *
 * In the cadastre preset this same event fires with `severity: 'error'` and the
 * feature is never stored. Here it fires with `severity: 'warning'` and the feature is
 * already on the map behind this panel. Nothing in the topology plugin changed.
 */
map.events.on('validation:failed', (event) => {
  renderIssues(event.payload.issues)
  const overlaps = event.payload.issues.filter((issue) => issue.rule === RULE_IDS.overlap)
  if (overlaps.length > 0) {
    status(
      'Overlap flagged — and ALLOWED. The zone is in the store. A planner dragging commerce ' +
        'over housing to see what it looks like is doing their job; the cadastre preset would ' +
        'have refused this exact write, with this exact rule.',
    )
  }
})

/* The same issues, on demand, over the whole plan rather than over the feature being
 * written — which is how a planner checks an imported plan before believing it. */
map.events.on('topology:issues', (event) => renderIssues(event.payload.issues))

button('check-topology').addEventListener('click', () => {
  const ids = map.store
    .collection(COLLECTION)
    .all()
    .map((feature) => feature.id)
  void map.plugin('topology').validate(ids)
  status(`Checked ${ids.length} zones.`)
})

function renderIssues(issues: readonly ValidationIssue[]): void {
  const list = el<HTMLUListElement>('issues')
  if (issues.length === 0) {
    list.replaceChildren(empty('No issues. The plan is clean.'))
    return
  }

  list.replaceChildren(
    ...issues.map((issue) => {
      const item = document.createElement('li')
      item.className = `issue issue--${issue.severity}`
      item.innerHTML = `
        <span class="issue__severity">${issue.severity}</span>
        <span class="issue__rule">${issue.rule}</span>
        <span class="issue__message">${issue.message}</span>`

      // `issue.at` is why the rules carry a position at all: it is what makes
      // "zoom to the problem" possible without the UI re-deriving the geometry.
      const at = issue.at
      if (at !== undefined) {
        item.classList.add('issue--locatable')
        item.addEventListener('click', () => {
          map.renderer.setCamera({ center: at, zoom: 18, duration: 400 })
          select.select(issue.feature)
        })
      }
      return item
    }),
  )
}

/* ================================================================== *
 * 9. Scenarios — snapshot, switch, compare.
 * ================================================================== */

const scenarios = map.plugin('scenario')

button('scenario-snapshot').addEventListener('click', () => {
  const input = el<HTMLInputElement>('scenario-name')
  const name = input.value.trim()
  try {
    scenarios.create(name)
    input.value = ''
    status(`Scenario "${name}" snapshotted. Change the plan, then snapshot another and compare.`)
  } catch (err) {
    // The plugin refuses to silently overwrite somebody's afternoon of work, and says so.
    status(err instanceof Error ? err.message : String(err))
  }
})

scenarios.onChange(() => renderScenarios())

button('scenario-compare').addEventListener('click', () => {
  const a = el<HTMLSelectElement>('scenario-a').value
  const b = el<HTMLSelectElement>('scenario-b').value
  if (a === '' || b === '') return
  renderComparison(scenarios.compare(a, b))
})

function renderScenarios(): void {
  const all = scenarios.list()
  const list = el<HTMLUListElement>('scenarios')

  list.replaceChildren(
    ...(all.length === 0
      ? [empty('No scenarios yet.')]
      : all.map((scenario) => {
          const item = document.createElement('li')
          const active = scenario.name === scenarios.active

          const switchTo = document.createElement('button')
          switchTo.type = 'button'
          switchTo.className = `btn btn--small${active ? ' btn--active' : ''}`
          switchTo.textContent = scenario.name
          // A switch checks the current work into the active scenario first, then
          // restores this one — through the command bus, so Ctrl-Z brings it back.
          switchTo.addEventListener('click', () => {
            scenarios.switch(scenario.name)
            status(`Switched to "${scenario.name}". Ctrl-Z undoes even this.`)
          })

          const remove = document.createElement('button')
          remove.type = 'button'
          remove.className = 'btn btn--small btn--danger'
          remove.textContent = '×'
          remove.addEventListener('click', () => {
            scenarios.remove(scenario.name)
            renderScenarios()
          })

          item.append(switchTo, remove)
          return item
        })),
  )

  for (const id of ['scenario-a', 'scenario-b']) {
    const picker = el<HTMLSelectElement>(id)
    const previous = picker.value
    picker.replaceChildren(
      ...all.map((scenario) => {
        const option = document.createElement('option')
        option.value = scenario.name
        option.textContent = scenario.name
        return option
      }),
    )
    picker.value = all.some((s) => s.name === previous) ? previous : (all[0]?.name ?? '')
  }
  // Two scenarios, or there is nothing to compare.
  button('scenario-compare').disabled = all.length < 2
}

/**
 * The per-category area delta table.
 *
 * The numbers come from `scenarios.compare()`, which sums `crs.area()` per category
 * over each snapshot — planar, in the working CRS, in m². A spherical area here would
 * be wrong in the same direction in both scenarios, which is the kind of wrong that
 * survives review: the *delta* would look plausible and the totals would not be.
 */
function renderComparison(comparison: ScenarioComparison): void {
  const rows = comparison.categories
    .filter((row) => row.areaA > 0 || row.areaB > 0)
    .map((row) => {
      const sign = row.deltaM2 > 0 ? 'up' : row.deltaM2 < 0 ? 'down' : 'flat'
      const percent =
        // `null`, not `Infinity` or `100`: a category that goes from nothing to eight
        // hectares has not *grown* by any percentage — it has appeared.
        row.deltaPercent === null
          ? 'new'
          : `${row.deltaPercent > 0 ? '+' : ''}${row.deltaPercent.toFixed(1)}%`
      return `
        <tr>
          <td><span class="swatch" style="background:${colorOf(row.code)}"></span>${row.label}</td>
          <td class="num">${map.i18n.area(row.areaA)}</td>
          <td class="num">${map.i18n.area(row.areaB)}</td>
          <td class="num delta delta--${sign}">${row.deltaM2 > 0 ? '+' : ''}${map.i18n.area(row.deltaM2)}</td>
          <td class="num delta delta--${sign}">${percent}</td>
        </tr>`
    })
    .join('')

  el<HTMLDivElement>('comparison').innerHTML = `
    <table class="delta-table">
      <thead>
        <tr>
          <th>Category</th><th class="num">${comparison.a}</th><th class="num">${comparison.b}</th>
          <th class="num">Δ</th><th class="num">Δ%</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td>Total zoned</td>
          <td class="num">${map.i18n.area(comparison.totalA)}</td>
          <td class="num">${map.i18n.area(comparison.totalB)}</td>
          <td class="num">${map.i18n.area(comparison.totalB - comparison.totalA)}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>`
}

/* ================================================================== *
 * 10. Small helpers. Nothing architectural below this line.
 * ================================================================== */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`[example] #${id} is not in index.html`)
  return node as T
}

function button(id: string): HTMLButtonElement {
  return el<HTMLButtonElement>(id)
}

function text(id: string, value: string): void {
  el(id).textContent = value
}

function empty(message: string): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'empty'
  item.textContent = message
  return item
}

function status(message: string): void {
  const node = el<HTMLDivElement>('status')
  node.textContent = message
  node.classList.add('status--visible')
}

/** The zoning code on a feature, with the same fallback bucket the preset's report uses. */
function codeOf(feature: BlaeuFeature): string {
  const raw = feature.properties[FIELD.zoning]
  return typeof raw === 'string' && raw.length > 0 ? raw : 'unzoned'
}

function colorOf(code: string): string {
  return categories.find((category) => category.code === code)?.color ?? '#b8b8b8'
}

function boundsOf(features: readonly BlaeuFeature[]): Bbox {
  let [w, s, e, n] = [180, 90, -180, -90]
  for (const feature of features) {
    if (feature.geometry.type !== 'Polygon') continue
    for (const ring of feature.geometry.coordinates) {
      for (const position of ring) {
        const [lng, lat] = position as unknown as LngLat
        w = Math.min(w, lng)
        s = Math.min(s, lat)
        e = Math.max(e, lng)
        n = Math.max(n, lat)
      }
    }
  }
  return [w, s, e, n]
}

/* First paint. Everything after this is driven by events. */
renderLegend()
renderAttributeForm()
renderScenarios()
map.tools.activate(SINGLE_TOOL)
status('Six blocks of an imaginary Ankara plan. Draw a zone, or select one to edit it.')
