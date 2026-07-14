import { describe, expect, it } from 'vitest'
import {
  composePresets,
  definePreset,
  normalisePluginSpec,
  overridePreset,
  type Preset,
} from '@fleximap/core'
import { snapPlugin } from '@fleximap/plugin-snap'

import { urbanPlanningPreset } from './preset.js'
import { DEFAULT_ZONING_CATEGORIES, zoningAttributeSchema, zoningFillColour } from './zoning.js'
import type { ZoningCategory } from './types.js'

/* ------------------------------------------------------------------------- */
/* Helpers — a preset is a value, so testing it really is asserting its value  */
/* ------------------------------------------------------------------------- */

function pluginIds(preset: Preset): readonly string[] {
  return (preset.plugins ?? []).map((spec) => normalisePluginSpec(spec).plugin.id)
}

function optionsFor(preset: Preset, id: string): Record<string, unknown> {
  const spec = (preset.plugins ?? []).find((s) => normalisePluginSpec(s).plugin.id === id)
  if (spec === undefined) throw new Error(`no plugin "${id}" in preset "${preset.id}"`)
  return (normalisePluginSpec(spec).options ?? {}) as Record<string, unknown>
}

function severities(preset: Preset): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rule of preset.validation ?? []) out[rule.id] = rule.severity
  return out
}

/* ------------------------------------------------------------------------- */
/* Shape                                                                       */
/* ------------------------------------------------------------------------- */

describe('urbanPlanningPreset — shape', () => {
  it('is a plain data structure with no side effects', () => {
    const preset = urbanPlanningPreset()

    expect(preset.id).toBe('urban')
    expect(preset.locale).toBe('tr')
    // Preset rule 1: a value, not a subclass and not a constructor call.
    expect(Object.getPrototypeOf(preset)).toBe(Object.prototype)
  })

  it('installs the plugin set, in install order', () => {
    expect(pluginIds(urbanPlanningPreset())).toEqual([
      'snap',
      'select',
      'draw',
      'edit',
      'measure',
      'topology',
      'history',
      'scenario',
    ])
  })

  it('snaps loosely, on a 5 m grid — the two numbers that make this preset not-cadastre', () => {
    const snap = optionsFor(urbanPlanningPreset(), 'snap')

    expect(snap['tolerance']).toBe(20)
    expect(snap['gridSize']).toBe(5)
    expect(snap['providers']).toContain('grid')
  })

  it('works in the projected plane, at centimetre precision', () => {
    expect(urbanPlanningPreset().config?.crs).toEqual({
      working: 'EPSG:5254',
      display: 'projected',
      precision: 2,
    })
  })

  it('keeps a deep undo stack — planners explore', () => {
    expect(optionsFor(urbanPlanningPreset(), 'history')['limit']).toBe(500)
  })

  it('measures in hectares, planar', () => {
    const measure = optionsFor(urbanPlanningPreset(), 'measure')
    expect(measure['areaUnit']).toBe('ha')
    expect(measure['planar']).toBe(true)
  })

  /**
   * The assertion this whole preset exists to make.
   *
   * Same topology plugin as cadastre. Overlaps and gaps are `warning` here and
   * `error` there, and *nothing in the plugin changed*. If someone ever "fixes" this
   * by hardcoding a severity inside the plugin, this test is what fails.
   */
  it('reports planning topology as warnings and structural damage as errors', () => {
    expect(severities(urbanPlanningPreset())).toEqual({
      'topology.closed-rings': 'error',
      'topology.duplicate-vertices': 'error',
      'topology.self-intersection': 'error',
      'topology.overlap': 'warning',
      'topology.gap': 'warning',
      'topology.slivers': 'warning',
      'topology.min-area': 'warning',
    })
  })

  it('is a snapshot of a data structure, and that is the whole point', () => {
    const preset = urbanPlanningPreset()

    expect({
      id: preset.id,
      locale: preset.locale,
      crs: preset.config?.crs,
      plugins: pluginIds(preset),
      validation: severities(preset),
      layers: (preset.layers ?? []).map((layer) => ({
        id: layer.id,
        type: layer.type,
        source: layer.source,
      })),
      themeId: (preset.theme as { id?: string } | undefined)?.id,
      locales: Object.keys(preset.i18n ?? {}),
    }).toMatchInlineSnapshot(`
      {
        "crs": {
          "display": "projected",
          "precision": 2,
          "working": "EPSG:5254",
        },
        "id": "urban",
        "layers": [
          {
            "id": "zoning-fill",
            "source": "zoning",
            "type": "vector",
          },
          {
            "id": "zoning-outline",
            "source": "zoning",
            "type": "vector",
          },
        ],
        "locale": "tr",
        "locales": [
          "tr",
          "en",
        ],
        "plugins": [
          "snap",
          "select",
          "draw",
          "edit",
          "measure",
          "topology",
          "history",
          "scenario",
        ],
        "themeId": "fleximap-urban",
        "validation": {
          "topology.closed-rings": "error",
          "topology.duplicate-vertices": "error",
          "topology.gap": "warning",
          "topology.min-area": "warning",
          "topology.overlap": "warning",
          "topology.self-intersection": "error",
          "topology.slivers": "warning",
        },
      }
    `)
  })
})

/* ------------------------------------------------------------------------- */
/* Options                                                                     */
/* ------------------------------------------------------------------------- */

describe('urbanPlanningPreset — options', () => {
  it('drops the scenario plugin when scenarios are off', () => {
    expect(pluginIds(urbanPlanningPreset({ scenarios: false }))).not.toContain('scenario')
  })

  it('drops grid snapping when gridSize is 0 — a sketch tool with no module', () => {
    const snap = optionsFor(urbanPlanningPreset({ gridSize: 0 }), 'snap')

    expect(snap['gridSize']).toBeUndefined()
    expect(snap['providers']).not.toContain('grid')
  })

  it('lets a jurisdiction promote overlaps to blocking errors without touching a plugin', () => {
    const strict = severities(urbanPlanningPreset({ topologySeverity: 'error' }))

    expect(strict['topology.overlap']).toBe('error')
    expect(strict['topology.gap']).toBe('error')
  })

  it('derives the topology tolerance from the readout precision, so the two cannot disagree', () => {
    expect(optionsFor(urbanPlanningPreset({ precision: 3 }), 'topology')['tolerance']).toBeCloseTo(
      0.001,
      12,
    )
  })

  it('carries a custom legend into the fill expression, the forms and the layers', () => {
    const categories: readonly ZoningCategory[] = [
      { code: 'TUR', label: 'Turizm Tesis Alanı', color: '#f472b6', maxFar: 0.6, maxHeight: 12 },
      { code: 'YA', label: 'Yeşil Alan', color: '#4c9f70' },
    ]
    const preset = urbanPlanningPreset({ zoningCategories: categories, defaultCategory: 'YA' })

    const fill = preset.layers?.[0]
    expect(fill?.style?.fill?.color).toEqual([
      'match',
      ['get', 'zoning'],
      'TUR',
      '#f472b6',
      'YA',
      '#4c9f70',
      '#b8b8b8',
    ])

    const schema = (fill?.config?.['attributes'] ?? {}) as Record<string, { fields: unknown[] }>
    expect(Object.keys(schema)).toEqual(['TUR', 'YA'])

    // A new polygon lands already classified, with the requested default.
    const properties = optionsFor(preset, 'draw')['properties'] as () => Record<string, unknown>
    expect(properties()).toEqual({ zoning: 'YA' })
  })

  it('rejects a defaultCategory that is not in the legend, at construction', () => {
    expect(() => urbanPlanningPreset({ defaultCategory: 'ZZZ' })).toThrow(
      /defaultCategory "ZZZ" is not in zoningCategories/,
    )
  })

  it('rejects a duplicate zoning code — it would silently merge two categories', () => {
    expect(() =>
      urbanPlanningPreset({
        zoningCategories: [
          { code: 'K', label: 'Konut', color: '#111' },
          { code: 'K', label: 'Konut 2', color: '#222' },
        ],
      }),
    ).toThrow(/zoning code "K" appears twice/)
  })

  it('rejects an empty legend and an opacity given as a percentage', () => {
    expect(() => urbanPlanningPreset({ zoningCategories: [] })).toThrow(/zoningCategories is empty/)
    expect(() => urbanPlanningPreset({ fillOpacity: 55 })).toThrow(/0\.55, not 55/)
  })
})

/* ------------------------------------------------------------------------- */
/* Composition — how a municipality customises without forking                 */
/* ------------------------------------------------------------------------- */

describe('composePresets over the urban preset', () => {
  it('retunes snapTolerance without re-declaring the snap plugin', () => {
    // İzmir digitises at 1/1000, where 20 px is a whole building. They say so in six
    // lines and inherit everything else — including the provider list and the 5 m
    // grid, which they never mention.
    const izmir = composePresets(
      urbanPlanningPreset(),
      definePreset({
        id: 'izmir',
        plugins: [[snapPlugin, { tolerance: 8 }]],
        config: { crs: { working: 'EPSG:5255' } },
      }),
    )

    const snap = optionsFor(izmir, 'snap')
    expect(snap['tolerance']).toBe(8)
    expect(snap['gridSize']).toBe(5)
    expect(snap['providers']).toContain('grid')

    // Retuned *in place*: snap keeps its install position, so nothing that installs
    // after it moves.
    expect(pluginIds(izmir)[0]).toBe('snap')

    // Deep merge: the belt changes, the precision and display do not.
    expect(izmir.config?.crs).toEqual({
      working: 'EPSG:5255',
      display: 'projected',
      precision: 2,
    })

    // The base's judgement survives untouched.
    expect(severities(izmir)['topology.overlap']).toBe('warning')
    expect(izmir.id).toBe('izmir')
  })

  it('appends rules and layers rather than replacing them', () => {
    const composed = composePresets(
      urbanPlanningPreset(),
      definePreset({
        id: 'izmir',
        layers: [{ id: 'izmir-kentsel-donusum', type: 'vector', source: 'donusum' }],
        validation: [{ id: 'izmir.plan-notu-required', severity: 'warning', check: () => [] }],
      }),
    )

    expect((composed.layers ?? []).map((l) => l.id)).toEqual([
      'zoning-fill',
      'zoning-outline',
      'izmir-kentsel-donusum',
    ])
    expect(Object.keys(severities(composed))).toContain('izmir.plan-notu-required')
    expect(Object.keys(severities(composed))).toContain('topology.overlap')
  })

  it('merges i18n per locale, later wins per key', () => {
    const composed = composePresets(
      urbanPlanningPreset(),
      definePreset({ id: 'izmir', i18n: { tr: { 'urban.zoning.K': 'Konut (İZBB)' } } }),
    )

    expect(composed.i18n?.['tr']?.['urban.zoning.K']).toBe('Konut (İZBB)')
    // Everything the override did not mention is still there.
    expect(composed.i18n?.['tr']?.['urban.field.kaks']).toBe('KAKS (Emsal)')
    expect(composed.i18n?.['en']?.['urban.zoning.K']).toBe('Residential')
  })

  it('overridePreset replaces — the escape hatch for a demo with no rules at all', () => {
    const demo = overridePreset(urbanPlanningPreset(), { validation: [] })

    expect(demo.validation).toEqual([])
    expect(pluginIds(demo)).toContain('topology')
  })
})

/* ------------------------------------------------------------------------- */
/* Legend-derived data                                                         */
/* ------------------------------------------------------------------------- */

describe('the legend drives the styling and the forms', () => {
  it('builds one match expression for N categories, with a fallback', () => {
    const expression = zoningFillColour(DEFAULT_ZONING_CATEGORIES, 'zoning')

    expect(expression[0]).toBe('match')
    expect(expression[1]).toEqual(['get', 'zoning'])
    // code/colour pairs, then the mandatory fallback: 2 + 2N + 1.
    expect(expression).toHaveLength(2 + DEFAULT_ZONING_CATEGORIES.length * 2 + 1)
    expect(expression.at(-1)).toBe('#b8b8b8')
  })

  it('caps the form fields at the plan caps, and leaves them uncapped where the plan does', () => {
    const schema = zoningAttributeSchema(DEFAULT_ZONING_CATEGORIES)

    const konut = schema['K']?.fields.find((f) => f.name === 'kaks')
    expect(konut?.max).toBe(1.5)

    // Yeşil alan has no KAKS in the legend, so the form has no cap — not a cap of 0,
    // which would be a number the plan never wrote.
    const yesil = schema['YA']?.fields.find((f) => f.name === 'kaks')
    expect(yesil).toBeDefined()
    expect(yesil && 'max' in yesil).toBe(false)

    // Every form offers every category, so re-zoning is a dropdown, not a redraw.
    const zoning = schema['K']?.fields.find((f) => f.name === 'zoning')
    expect(zoning?.options?.map((o) => o.value)).toEqual(['K', 'T', 'S', 'YA', 'D'])
  })
})
