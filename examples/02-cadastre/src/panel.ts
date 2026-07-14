/**
 * The side panel: plain DOM, no framework.
 *
 * Everything here reads the map through its public API and writes to it through the
 * command bus. There is no back channel and no shared mutable state — which is why a
 * React or Vue version of this panel would be the same code with different glue.
 *
 * Note what the panel deliberately does *not* own:
 *
 * - the coordinate readout (`Y=… X=…`), the scale bar, the snap indicator, the
 *   toolbar, the undo/redo buttons and the validation issue list are all mounted
 *   *inside the map* by `@fleximap/plugin-ui`, which the cadastre preset installs.
 *   Re-implementing them here would be a worse version of something the library
 *   already ships.
 * - the yüzölçümü. It is **derived**: computed from the geometry, in the projected
 *   working CRS, every time it is displayed. There is no input to type it into, and
 *   that is the point.
 */

import {
  SetPropertiesCommand,
  type FeatureId,
  type FlexiFeature,
  type FlexiMap,
  type Geometry,
  type Json,
  type ValidationIssue,
} from '@fleximap/core'
import { PARCELS_COLLECTION, parcelSchema } from '@fleximap/preset-cadastre'

/* ========================================================================= */
/* Tiny DOM helper. Not a framework; forty lines of `document.createElement`. */
/* ========================================================================= */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  // `textContent`, never `innerHTML`. A malik's name is user data, and an attribute
  // table is not an XSS sink.
  if (text !== undefined) node.textContent = text
  return node
}

function slot(id: string): HTMLElement {
  const host = document.getElementById(id)
  if (host === null) throw new Error(`[example] #${id} is missing from index.html`)
  return host
}

/* ========================================================================= */
/* Formatting                                                                */
/* ========================================================================= */

/**
 * Dönüm *and* m², from the geometry, planar.
 *
 * `map.crs.area()` projects into TUREF/TM30 and does the maths in metres — see the
 * "Yüzölçümü neden düzlemsel?" panel. Dönüm (1 000 m²) is the unit the number is said
 * out loud in; m² is the unit it is written down in. A surveyor wants both, and
 * `i18n.number` puts the separators the Turkish way round: `2.184,00`.
 */
export function formatArea(map: FlexiMap, geometry: Geometry): string {
  const m2 = map.crs.area(geometry)
  const donum = map.i18n.number(m2 / 1000, {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  })
  const metres = map.i18n.number(m2, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${donum} dönüm · ${metres} m²`
}

function parcelName(feature: FlexiFeature): string {
  const ada = asText(feature.properties['ada']) || '—'
  const parsel = asText(feature.properties['parsel']) || '—'
  return `${ada}/${parsel}`
}

function asText(value: Json | undefined): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

/* ========================================================================= */
/* Live status: snapping, shared corners, rejected writes                    */
/* ========================================================================= */

export interface LivePanel {
  setSnap(text: string | null): void
  /** The topology index's answer for the point under the cursor. */
  setSharedCorner(features: readonly FlexiFeature[] | null): void
  /** A transient "that just happened" line — a topological move, an accepted parcel. */
  flash(text: string): void
  /** A rejected (or newly invalid) write. `at` drives the "hataya git" button. */
  setIssues(issues: readonly ValidationIssue[], headline: string | null): void
}

export function createLivePanel(map: FlexiMap): LivePanel {
  const host = slot('live')
  host.append(el('h2', undefined, 'Canlı durum'))

  const snap = el('div', 'kv')
  const snapValue = el('span', 'kv-value', '—')
  snap.append(el('span', 'kv-key', 'Yakalama'), snapValue)

  const shared = el('div', 'badge badge-idle', 'Ortak köşe yok')
  const flashLine = el('div', 'flash')
  flashLine.hidden = true

  const issues = el('div', 'issues')
  issues.hidden = true

  host.append(snap, shared, flashLine, issues)

  let flashTimer: number | undefined

  return {
    setSnap(text) {
      snapValue.textContent = text ?? '—'
      snapValue.classList.toggle('kv-live', text !== null)
    },

    setSharedCorner(features) {
      if (features === null || features.length < 2) {
        shared.className = 'badge badge-idle'
        shared.textContent = 'Ortak köşe yok'
        return
      }
      shared.className = 'badge badge-hot'
      shared.textContent = `Ortak köşe · ${features.length} parsel: ${features
        .map(parcelName)
        .join(', ')}`
    },

    flash(text) {
      flashLine.textContent = text
      flashLine.hidden = false
      flashLine.classList.remove('flash-run')
      // Force a reflow so the animation restarts when the same message fires twice.
      void flashLine.offsetWidth
      flashLine.classList.add('flash-run')
      window.clearTimeout(flashTimer)
      flashTimer = window.setTimeout(() => {
        flashLine.hidden = true
      }, 4000)
    },

    setIssues(list, headline) {
      issues.replaceChildren()
      issues.hidden = list.length === 0

      if (headline !== null) issues.append(el('div', 'issues-head', headline))

      for (const issue of list) {
        const row = el('div', `issue issue-${issue.severity}`)
        row.append(el('span', 'issue-text', issue.message))

        const at = issue.at
        if (at !== undefined) {
          const zoom = el('button', 'btn btn-tiny', 'Hataya git')
          zoom.type = 'button'
          // The single affordance that turns a validation error from an accusation
          // into a fix: a surveyor with an overlap needs to be *at* the overlap.
          zoom.addEventListener('click', () => {
            map.renderer.setCamera({ center: at, zoom: 19, duration: 600 })
          })
          row.append(zoom)
        }
        issues.append(row)
      }
    },
  }
}

/* ========================================================================= */
/* The parcel table — where the money shot is visible                        */
/* ========================================================================= */

export interface ParcelTable {
  refresh(): void
  setSelected(ids: ReadonlySet<FeatureId>): void
}

/**
 * Every parcel, with its derived area.
 *
 * This is where topological editing becomes *visible*. Drag the shared corner and
 * three rows change at once, and the ones that changed flash. One boundary, three
 * parcels, one command, one Ctrl+Z. If the areas moved one at a time you would be
 * looking at a bug — and a strip of land with no owner.
 */
export function createParcelTable(map: FlexiMap, onSelect: (id: FeatureId) => void): ParcelTable {
  const host = slot('parcels')
  host.append(el('h2', undefined, 'Parseller (yüzölçümü geometriden türetilir)'))

  const table = el('table', 'table')
  const head = el('thead')
  const headRow = el('tr')
  for (const label of ['Ada/Parsel', 'Malik', 'Yüzölçümü']) {
    headRow.append(el('th', undefined, label))
  }
  head.append(headRow)
  const body = el('tbody')
  table.append(head, body)
  host.append(table)

  /**
   * Which revision of each parcel we last drew.
   *
   * The flash keys on `meta.version` — the store's own monotonic per-feature revision —
   * and **not** on whether the area changed. That distinction is not pedantry, and it
   * took a headless run of this example to notice it: drag the three-way node sideways
   * and 102/9's corner slides *along its own southern edge*, so its geometry changes
   * while its area does not. Flashing on the area would have quietly hidden the third
   * parcel — the one whose participation is the least obvious and the most worth seeing.
   */
  const drawnVersion = new Map<FeatureId, number>()
  let selected: ReadonlySet<FeatureId> = new Set()

  const render = (): void => {
    body.replaceChildren()

    for (const feature of map.store.collection(PARCELS_COLLECTION).all()) {
      const before = drawnVersion.get(feature.id)
      const moved = before !== undefined && before !== feature.meta.version
      drawnVersion.set(feature.id, feature.meta.version)

      const row = el('tr', selected.has(feature.id) ? 'row-selected' : undefined)
      if (moved) row.classList.add('row-changed')

      row.append(
        el('td', 'cell-id', parcelName(feature)),
        el('td', undefined, asText(feature.properties['malik']) || '—'),
        el('td', 'cell-area', formatArea(map, feature.geometry)),
      )
      row.addEventListener('click', () => onSelect(feature.id))
      body.append(row)
    }
  }

  render()

  return {
    refresh: render,
    setSelected(ids) {
      selected = ids
      render()
    },
  }
}

/* ========================================================================= */
/* The attribute panel — one schema drives the form and the validation rule  */
/* ========================================================================= */

export interface AttributePanel {
  show(feature: FlexiFeature | undefined): void
}

/**
 * The parcel record, built from `parcelSchema` — the *same* data structure the
 * cadastre preset's `parcelAttributesRule` validates against.
 *
 * Two sources of truth for "which fields does a parcel have" is exactly how a form
 * and a validator drift apart, and the day they do, the form happily accepts a
 * parcel the commit pipeline will refuse. So the form is generated from the schema.
 *
 * `derived: true` fields (there is one: `yuzolcumu`) are rendered as text, not as an
 * input. You cannot type an area here, because you cannot type an area at all.
 */
export function createAttributePanel(map: FlexiMap): AttributePanel {
  const host = slot('attributes')
  host.append(el('h2', undefined, 'Öznitelikler'))

  const empty = el('p', 'muted', 'Bir parsel seçin.')
  const form = el('div', 'form')
  form.hidden = true
  host.append(empty, form)

  const show = (feature: FlexiFeature | undefined): void => {
    form.replaceChildren()
    form.hidden = feature === undefined
    empty.hidden = feature !== undefined
    if (feature === undefined) return

    for (const field of parcelSchema.fields) {
      const row = el('label', 'field')
      row.append(el('span', 'field-label', map.i18n.t(field.labelKey)))

      if (field.derived === true) {
        // Never an input. The number is the geometry's, not the typist's.
        const value = el('span', 'field-derived', formatArea(map, feature.geometry))
        value.title = map.i18n.t('cadastre.attr.yuzolcumu.hint')
        row.append(value, el('span', 'field-hint', 'geometriden türetildi'))
        form.append(row)
        continue
      }

      const input = el('input', 'field-input')
      input.type = 'text'
      input.value = asText(feature.properties[field.name])
      if (field.maxLength !== undefined) input.maxLength = field.maxLength
      if (field.required === true) input.required = true

      // `change`, not `input`: one committed edit per field, not one per keystroke.
      // (SetPropertiesCommand coalesces keystrokes anyway — see its `coalesceWith` —
      // but a command per keystroke is still a command per keystroke.)
      input.addEventListener('change', () => {
        const next = input.value.trim()
        map.commands.dispatch(
          new SetPropertiesCommand(
            [feature.id],
            // `undefined` *removes* the key, which is what a cleared field means —
            // and it keeps the exported GeoJSON free of null confetti.
            { [field.name]: next === '' ? undefined : next },
            { label: `${map.i18n.t(field.labelKey)} değiştirildi` },
          ),
        )
      })

      row.append(input)
      form.append(row)
    }
  }

  show(undefined)
  return { show }
}

/* ========================================================================= */
/* Actions                                                                   */
/* ========================================================================= */

export interface ActionHandlers {
  readonly drawParcel: () => void
  readonly editCorners: () => void
  readonly selectMode: () => void
  readonly trySelfIntersecting: () => void
  readonly tryOverlapping: () => void
  readonly validateAll: () => void
}

export function createActions(handlers: ActionHandlers): void {
  const host = slot('actions')
  host.append(el('h2', undefined, 'Araçlar ve sınamalar'))

  const primary = el('div', 'btn-row')
  const checks = el('div', 'btn-row')

  const add = (
    parent: HTMLElement,
    label: string,
    className: string,
    onClick: () => void,
    title?: string,
  ): void => {
    const btn = el('button', className, label)
    btn.type = 'button'
    if (title !== undefined) btn.title = title
    btn.addEventListener('click', onClick)
    parent.append(btn)
  }

  add(primary, 'Seç', 'btn', handlers.selectMode)
  add(
    primary,
    'Parsel çiz',
    'btn',
    handlers.drawParcel,
    'Köşeleri tıklayın, kapatmak için çift tıklayın',
  )
  add(primary, 'Köşe düzenle', 'btn btn-accent', handlers.editCorners, 'Ortak köşeyi sürükleyin')

  add(
    checks,
    'Kendini kesen parsel dene',
    'btn btn-danger',
    handlers.trySelfIntersecting,
    'topology.selfIntersection — kayıt reddedilir',
  )
  add(
    checks,
    'Çakışan parsel dene',
    'btn btn-danger',
    handlers.tryOverlapping,
    'topology.overlap — çakışma bir ihtilaftır, kayıt reddedilir',
  )
  add(checks, 'Tümünü doğrula', 'btn', handlers.validateAll)

  host.append(primary, checks)
}
