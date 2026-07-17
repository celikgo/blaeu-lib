import { describe, expect, it } from 'vitest'
import {
  composePresets,
  definePreset,
  normalisePluginSpec,
  overridePreset,
  BlaeuCrsService,
  type CommitContext,
  type BlaeuFeature,
  type Position,
  type Preset,
  type ValidationContext,
  type ValidationIssue,
  type ValidationRule,
} from '@blaeu/core'
import { snapPlugin } from '@blaeu/plugin-snap'
import { RULE_IDS } from '@blaeu/plugin-topology'

import { cadastrePreset } from './preset.js'
import { deriveAreaMiddleware } from './derive.js'
import { parcelAttributesRule, parcelSchema } from './schema.js'

/* ------------------------------------------------------------------------- */
/* Helpers — a preset is a data structure, so testing it is asserting a value */
/* ------------------------------------------------------------------------- */

function pluginIds(preset: Preset): string[] {
  return (preset.plugins ?? []).map((spec) => normalisePluginSpec(spec).plugin.id)
}

function optionsFor(preset: Preset, id: string): Record<string, unknown> {
  const spec = (preset.plugins ?? []).find((s) => normalisePluginSpec(s).plugin.id === id)
  if (spec === undefined) throw new Error(`preset "${preset.id}" has no plugin "${id}"`)
  return (normalisePluginSpec(spec).options ?? {}) as Record<string, unknown>
}

/** rule id → severity. The severities *are* the preset's contribution. */
function severities(preset: Preset): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rule of preset.validation ?? []) out[rule.id] = rule.severity
  return out
}

function ruleById(preset: Preset, id: string): ValidationRule {
  const rule = (preset.validation ?? []).find((r) => r.id === id)
  if (rule === undefined) throw new Error(`preset "${preset.id}" has no rule "${id}"`)
  return rule
}

/** Everything about a preset that is data rather than behaviour. */
function shapeOf(preset: Preset): unknown {
  return {
    id: preset.id,
    locale: preset.locale,
    config: preset.config,
    layers: preset.layers,
    i18n: preset.i18n,
    theme: preset.theme,
    plugins: pluginIds(preset).map((id) => [id, optionsFor(preset, id)]),
    validation: severities(preset),
  }
}

/* ------------------------------------------------------------------------- */
/* Shape                                                                      */
/* ------------------------------------------------------------------------- */

describe('cadastrePreset — shape', () => {
  it('is a pure function: two calls produce equal, independent values', () => {
    const a = cadastrePreset()
    const b = cadastrePreset()

    expect(a).not.toBe(b)
    // Compared on the *serialisable* shape: a rule and a middleware are closures, and
    // two closures are never `toEqual`. That the config, the layers, the messages, the
    // plugin options and the rule severities are identical is the property that matters
    // — it is what makes a preset shippable as config over the wire.
    expect(shapeOf(a)).toEqual(shapeOf(b))
    expect(JSON.parse(JSON.stringify(a.config))).toEqual(JSON.parse(JSON.stringify(b.config)))
  })

  it('projects into TUREF/TM30, displays projected coordinates, and reads out to the millimetre', () => {
    const preset = cadastrePreset()

    expect(preset.id).toBe('cadastre')
    expect(preset.locale).toBe('tr')
    expect(preset.config?.crs).toEqual({
      working: 'EPSG:5254',
      display: 'projected',
      precision: 3,
    })
    // Double-click closes a ring here. Zooming as well would throw the surveyor off
    // the work every time they finished a parcel.
    expect(preset.config?.interaction).toEqual({ doubleClickZoom: false })
  })

  it('installs the eight plugins, with the options that make them cadastral', () => {
    const preset = cadastrePreset()

    expect(pluginIds(preset)).toEqual([
      'snap',
      'draw',
      'edit',
      'topology',
      'measure',
      'select',
      'history',
      'ui',
    ])

    expect(optionsFor(preset, 'snap')).toEqual({
      tolerance: 12,
      providers: ['vertex', 'edge', 'midpoint', 'intersection', 'extension'],
    })
    expect(optionsFor(preset, 'draw')).toEqual({ defaultMode: 'polygon', collection: 'parcels' })
    // Non-negotiable: a shared corner moves in both parcels or the two drift apart.
    expect(optionsFor(preset, 'edit')).toEqual({ topological: true, handleSize: 10 })
    // The software reports; the surveyor decides.
    expect(optionsFor(preset, 'topology')).toEqual({
      autoFix: false,
      tolerance: 0.001,
      sliverRatio: 100,
    })
    expect(optionsFor(preset, 'measure')).toEqual({
      areaUnit: 'donum',
      lengthUnit: 'm',
      planar: true,
    })
    expect(optionsFor(preset, 'select')).toEqual({ collections: ['parcels'] })
    expect(optionsFor(preset, 'history')).toEqual({ limit: 200 })
  })

  it('makes an overlap an error and a gap a warning — a dispute versus a slip of the mouse', () => {
    expect(severities(cadastrePreset())).toEqual({
      [RULE_IDS.closedRings]: 'error',
      [RULE_IDS.duplicateVertices]: 'error',
      [RULE_IDS.selfIntersection]: 'error',
      [RULE_IDS.overlap]: 'error',
      [RULE_IDS.gap]: 'warning',
      [RULE_IDS.minArea]: 'warning',
      [RULE_IDS.slivers]: 'warning',
      // The geometry is drawn before the deed is typed; an error here would make a
      // parcel impossible to store *until* it was attributed.
      'cadastre.attributes': 'warning',
    })
  })

  it('declares the three layers, with buildings under parcels', () => {
    const layers = cadastrePreset().layers ?? []
    expect(layers.map((l) => l.id)).toEqual(['buildings', 'parcels', 'parcel-labels'])
    expect(layers.map((l) => l.source)).toEqual(['buildings', 'parcels', 'parcels'])
  })

  it('ships tr and en, with the vocabulary a surveyor uses', () => {
    const preset = cadastrePreset()

    expect(Object.keys(preset.i18n ?? {}).sort()).toEqual(['en', 'tr'])
    // "parsel", never "parça" — this is the assertion that fails if somebody
    // "improves" the translation without asking a surveyor.
    expect(preset.i18n?.['tr']?.['cadastre.attr.parsel']).toBe('Parsel')
    expect(preset.i18n?.['tr']?.['cadastre.attr.ada']).toBe('Ada')
    expect(preset.i18n?.['tr']?.['cadastre.attr.malik']).toBe('Malik')
    expect(preset.i18n?.['tr']?.['cadastre.attr.yuzolcumu']).toBe('Yüzölçümü')
    expect(preset.i18n?.['tr']?.['tool.draw:polygon']).toBe('Parsel çiz')
  })

  it('restricts the relational rules to parcels — a building legitimately sits inside its parcel', () => {
    const preset = cadastrePreset()
    const overlap = ruleById(preset, RULE_IDS.overlap)

    expect(overlap.appliesTo?.(polygonFeature('a', 'parcels'))).toBe(true)
    expect(overlap.appliesTo?.(polygonFeature('b', 'buildings'))).toBe(false)

    // …while a structural defect is a defect wherever it is.
    const selfIntersection = ruleById(preset, RULE_IDS.selfIntersection)
    expect(selfIntersection.appliesTo?.(polygonFeature('b', 'buildings'))).not.toBe(false)
  })
})

/* ------------------------------------------------------------------------- */
/* Options — every knob a domain expert would touch                           */
/* ------------------------------------------------------------------------- */

describe('cadastrePreset — options', () => {
  it('takes another TUREF belt and another locale', () => {
    const preset = cadastrePreset({ crs: 'EPSG:5255', locale: 'en' })
    expect(preset.config?.crs?.working).toBe('EPSG:5255')
    expect(preset.locale).toBe('en')
  })

  it('renames the collections everywhere they are referenced at once', () => {
    const preset = cadastrePreset({ collections: { parcels: 'kadastro', buildings: 'yapilar' } })

    expect(optionsFor(preset, 'draw')['collection']).toBe('kadastro')
    expect(optionsFor(preset, 'select')['collections']).toEqual(['kadastro'])
    expect((preset.layers ?? []).map((l) => l.source)).toEqual(['yapilar', 'kadastro', 'kadastro'])
    expect(ruleById(preset, RULE_IDS.overlap).appliesTo?.(polygonFeature('a', 'kadastro'))).toBe(
      true,
    )
  })

  it('strictTopology promotes the advisory rules to errors — the submission boundary', () => {
    const strict = severities(cadastrePreset({ strictTopology: true }))

    expect(strict[RULE_IDS.gap]).toBe('error')
    expect(strict[RULE_IDS.minArea]).toBe('error')
    expect(strict[RULE_IDS.slivers]).toBe('error')
    // Still an error, and still for a different reason.
    expect(strict[RULE_IDS.overlap]).toBe('error')
  })

  it('honours minParcelArea, snapTolerance and historyLimit', () => {
    const preset = cadastrePreset({ minParcelArea: 250, snapTolerance: 8, historyLimit: 500 })

    expect(optionsFor(preset, 'snap')['tolerance']).toBe(8)
    expect(optionsFor(preset, 'history')['limit']).toBe(500)
    expect(ruleById(preset, RULE_IDS.minArea).severity).toBe('warning')
  })

  it('drops the attribute rule entirely when attributes are captured elsewhere', () => {
    expect(severities(cadastrePreset({ attributeSeverity: 'off' }))['cadastre.attributes']).toBe(
      undefined,
    )
  })

  it('omits the area middleware when the host stamps the area itself', () => {
    expect(cadastrePreset().commitMiddleware).toHaveLength(1)
    expect(cadastrePreset({ deriveArea: false }).commitMiddleware).toBeUndefined()
  })

  it('rejects a nonsense snap tolerance at the point it is written, not at the first pointer move', () => {
    expect(() => cadastrePreset({ snapTolerance: -1 })).toThrow(/snapTolerance/)
    expect(() => cadastrePreset({ precision: 1.5 })).toThrow(/precision/)
  })
})

/* ------------------------------------------------------------------------- */
/* Composition — how a municipality customises without forking                */
/* ------------------------------------------------------------------------- */

describe('composing over the cadastre preset', () => {
  it('retunes snap without re-declaring the provider list, and keeps the install position', () => {
    const izmir = composePresets(
      cadastrePreset({ crs: 'EPSG:5255' }),
      definePreset({
        id: 'izmir',
        plugins: [[snapPlugin, { tolerance: 8 }]],
        config: { crs: { precision: 4 } },
      }),
    )

    // The retuned option merged in; the base's judgement about *which* providers a
    // surveyor needs survived untouched. That is the whole point of the merge rule.
    expect(optionsFor(izmir, 'snap')).toEqual({
      tolerance: 8,
      providers: ['vertex', 'edge', 'midpoint', 'intersection', 'extension'],
    })
    // In place: snap still installs first, so anything that depends on it still
    // finds it where the base preset put it.
    expect(pluginIds(izmir)[0]).toBe('snap')

    // config deep-merges: the belt survives, the precision is overridden.
    expect(izmir.config?.crs).toEqual({
      working: 'EPSG:5255',
      display: 'projected',
      precision: 4,
    })
    expect(izmir.id).toBe('izmir')
  })

  it('appends rules and layers rather than replacing them', () => {
    const extra: ValidationRule = { id: 'izmir.zoning', severity: 'warning', check: () => [] }

    const izmir = composePresets(
      cadastrePreset(),
      definePreset({
        id: 'izmir',
        validation: [extra],
        layers: [{ id: 'izmir-zoning', type: 'vector', source: 'zoning' }],
        i18n: { tr: { 'cadastre.attr.nitelik': 'Kullanım şekli' } },
      }),
    )

    expect(severities(izmir)[RULE_IDS.overlap]).toBe('error')
    expect(severities(izmir)['izmir.zoning']).toBe('warning')
    expect((izmir.layers ?? []).map((l) => l.id)).toContain('izmir-zoning')
    // i18n merges per key, later wins — one string overridden, the rest inherited.
    expect(izmir.i18n?.['tr']?.['cadastre.attr.nitelik']).toBe('Kullanım şekli')
    expect(izmir.i18n?.['tr']?.['cadastre.attr.ada']).toBe('Ada')
  })

  it('can throw the base rules away entirely — a demo environment that must not enforce them', () => {
    const demo = overridePreset(cadastrePreset(), { validation: [] })
    expect(demo.validation).toEqual([])
    expect(pluginIds(demo)).toContain('topology')
  })
})

/* ------------------------------------------------------------------------- */
/* The attribute schema, and the derived area                                 */
/* ------------------------------------------------------------------------- */

describe('parcel attributes', () => {
  it('reports a parcel with no ada/parsel, and says which field is missing', () => {
    const rule = parcelAttributesRule(parcelSchema, { collection: 'parcels' })
    const feature = polygonFeature('p1', 'parcels', { pafta: 'K25' })

    const issues = rule.check(feature, ctx()) as readonly { data?: Record<string, unknown> }[]
    expect(issues.map((i) => i.data?.['field'])).toEqual(['ada', 'parsel'])
  })

  it('never reports the derived area as missing — that would be blaming the surveyor for our bug', () => {
    const rule = parcelAttributesRule(parcelSchema, {})
    const issues = rule.check(polygonFeature('p1', 'parcels', { ada: '102', parsel: '7' }), ctx())
    expect(issues).toEqual([])
  })

  it('catches an area someone typed as a string', () => {
    const rule = parcelAttributesRule(parcelSchema, {})
    const issues = rule.check(
      polygonFeature('p1', 'parcels', { ada: '102', parsel: '7', yuzolcumu: '1000' }),
      ctx(),
    ) as readonly ValidationIssue[]

    expect(issues).toHaveLength(1)
    expect(issues[0]?.data).toMatchObject({ field: 'yuzolcumu', expected: 'number' })
  })
})

describe('deriveAreaMiddleware', () => {
  it('stamps the planar area, in m², from the geometry — never from what was typed', async () => {
    const crs = new BlaeuCrsService({ working: 'EPSG:5254', display: 'projected', precision: 3 })
    // A 100 m × 100 m square built in the *projected* plane and pushed back to 4326,
    // so the expected answer is exactly 10 000 m² by construction rather than by a
    // second implementation of the same maths.
    const [e, n] = crs.working.forward([32.85, 39.93])
    const corner = (dx: number, dy: number): Position => [...crs.working.inverse([e + dx, n + dy])]
    const square: Position[] = [
      corner(0, 0),
      corner(100, 0),
      corner(100, 100),
      corner(0, 100),
      corner(0, 0),
    ]

    const feature: BlaeuFeature = {
      ...polygonFeature('p1', 'parcels', { ada: '102', parsel: '7', yuzolcumu: 9000 }),
      geometry: { type: 'Polygon', coordinates: [square] },
    }

    const middleware = deriveAreaMiddleware({
      crs: 'EPSG:5254',
      precision: 3,
      collection: 'parcels',
      decimals: 2,
    })

    const commit = commitContext([feature])
    await middleware(commit, async () => {})

    // The 9 000 m² somebody typed is gone; the boundary is what the parcel is.
    expect(commit.features[0]?.properties['yuzolcumu']).toBeCloseTo(10_000, 1)
  })

  it('leaves other collections alone — a building has no yüzölçümü of record', async () => {
    const building = polygonFeature('b1', 'buildings')
    const middleware = deriveAreaMiddleware({
      crs: 'EPSG:5254',
      precision: 3,
      collection: 'parcels',
      decimals: 2,
    })

    const commit = commitContext([building])
    await middleware(commit, async () => {})

    expect(commit.features[0]).toBe(building)
    expect(commit.features[0]?.properties['yuzolcumu']).toBeUndefined()
  })
})

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

function polygonFeature(
  id: string,
  collection: string,
  properties: Record<string, string | number> = {},
): BlaeuFeature {
  return {
    id,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [32.85, 39.93],
          [32.851, 39.93],
          [32.851, 39.931],
          [32.85, 39.931],
          [32.85, 39.93],
        ],
      ],
    },
    properties,
    meta: { collection, version: 1, createdAt: 0, updatedAt: 0 },
  }
}

/** A `ValidationContext` with a `t()` that returns the key — so assertions read on ids, not prose. */
function ctx(): ValidationContext {
  return {
    store: undefined as unknown as ValidationContext['store'],
    crs: undefined as unknown as ValidationContext['crs'],
    t: (key) => key,
  }
}

function commitContext(features: readonly BlaeuFeature[]): CommitContext {
  return {
    operation: 'add',
    features: [...features],
    previous: [],
    command: undefined,
    reject: () => {},
    rejected: false,
    rejectReason: undefined,
  }
}
