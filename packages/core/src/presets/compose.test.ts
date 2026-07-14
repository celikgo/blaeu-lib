import { describe, expect, it, vi } from 'vitest'
import type { FlexiPlugin } from '../types/plugin.js'
import type { Preset } from '../types/preset.js'
import type { ValidationRule } from '../types/validation.js'
import type { InteractionMiddleware } from '../types/pipeline.js'
import { composePresets, definePreset, normalisePluginSpec, overridePreset } from './compose.js'

/* ------------------------------------------------------------------------- */
/* Doubles                                                                     */
/* ------------------------------------------------------------------------- */

interface SnapOptions {
  tolerance?: number
  providers?: readonly string[]
  grid?: { size?: number; enabled?: boolean }
}

/** A plugin factory of the shape a preset actually writes: pure, fully defaulted. */
function makeFactory(id: string) {
  const calls: unknown[] = []
  const factory = (options: SnapOptions = {}): FlexiPlugin<{ id: string }, SnapOptions> => {
    calls.push(options)
    return { id, version: '1.0.0', setup: () => ({ id }) }
  }
  return Object.assign(factory, { calls })
}

function pluginObject(id: string): FlexiPlugin<{ id: string }, never> {
  return { id, version: '1.0.0', setup: () => ({ id }) }
}

function rule(id: string): ValidationRule {
  return { id, severity: 'error', check: () => [] }
}

const noopMiddleware: InteractionMiddleware = (_ctx, next) => next()

/** The install order a preset would produce, which is the thing worth asserting on. */
function pluginIds(preset: Preset): string[] {
  return (preset.plugins ?? []).map((spec) => normalisePluginSpec(spec).plugin.id)
}

function optionsFor(preset: Preset, id: string): unknown {
  const spec = (preset.plugins ?? []).find((s) => normalisePluginSpec(s).plugin.id === id)
  if (!spec) throw new Error(`no plugin "${id}" in preset "${preset.id}"`)
  return normalisePluginSpec(spec).options
}

/* ------------------------------------------------------------------------- */
/* normalisePluginSpec                                                         */
/* ------------------------------------------------------------------------- */

describe('normalisePluginSpec', () => {
  it('passes a plugin object straight through, with no options', () => {
    const plugin = pluginObject('draw')
    const { plugin: resolved, options } = normalisePluginSpec(plugin)

    expect(resolved).toBe(plugin)
    expect(options).toBeUndefined()
  })

  it('invokes the factory of a tuple spec, and hands the options to both the factory and the caller', () => {
    const snapPlugin = makeFactory('snap')
    const { plugin, options } = normalisePluginSpec([snapPlugin, { tolerance: 12 }])

    expect(plugin.id).toBe('snap')
    // Both destinations matter: a plugin that closes over its options needs the
    // factory call, and one that reads ctx.options needs the returned value.
    expect(snapPlugin.calls).toEqual([{ tolerance: 12 }])
    expect(options).toEqual({ tolerance: 12 })
  })

  it('tolerates a tuple with no options', () => {
    const snapPlugin = makeFactory('snap')
    const { plugin, options } = normalisePluginSpec([snapPlugin])

    expect(plugin.id).toBe('snap')
    expect(options).toBeUndefined()
  })

  it('leaves the factory un-invoked until it is normalised', () => {
    const snapPlugin = makeFactory('snap')
    const preset = definePreset({
      id: 'p',
      plugins: [[snapPlugin, { tolerance: 12 }]],
    })

    // definePreset reads the id (one pure call, no options) — but the *configured*
    // plugin is not built until installation, which is what lets a later preset
    // retune it first.
    expect(snapPlugin.calls).toEqual([{}])

    normalisePluginSpec(preset.plugins![0]!)
    expect(snapPlugin.calls).toEqual([{}, { tolerance: 12 }])
  })

  it('names the plugin when a factory throws', () => {
    const broken = (() => {
      throw new Error('boom')
    }) as unknown as (options?: never) => FlexiPlugin<unknown, never>

    expect(() => normalisePluginSpec([broken, {}])).toThrow(/must be pure/)
  })
})

/* ------------------------------------------------------------------------- */
/* definePreset                                                                */
/* ------------------------------------------------------------------------- */

describe('definePreset', () => {
  it('is the identity function on a valid preset', () => {
    const preset: Preset = { id: 'cadastre', locale: 'tr' }
    expect(definePreset(preset)).toBe(preset)
  })

  it('rejects a preset with no id', () => {
    expect(() => definePreset({ id: '' })).toThrow(/non-empty string "id"/)
  })

  it('rejects an unknown field — the typo that would otherwise be silently ignored', () => {
    const typo = { id: 'cadastre', validations: [rule('a')] } as unknown as Preset
    expect(() => definePreset(typo)).toThrow(/unknown field\(s\): validations/)
  })

  it('rejects the same plugin id declared twice', () => {
    const snapPlugin = makeFactory('snap')
    expect(() =>
      definePreset({
        id: 'cadastre',
        plugins: [[snapPlugin, { tolerance: 12 }], pluginObject('snap')],
      }),
    ).toThrow(/lists plugin "snap" twice/)
  })

  it('rejects duplicate layer ids and duplicate rule ids', () => {
    expect(() =>
      definePreset({
        id: 'cadastre',
        layers: [
          { id: 'parcels', type: 'vector' },
          { id: 'parcels', type: 'vector' },
        ],
      }),
    ).toThrow(/layer "parcels" twice/)

    expect(() =>
      definePreset({ id: 'cadastre', validation: [rule('no-overlap'), rule('no-overlap')] }),
    ).toThrow(/rule "no-overlap" twice/)
  })
})

/* ------------------------------------------------------------------------- */
/* composePresets                                                              */
/* ------------------------------------------------------------------------- */

describe('composePresets', () => {
  it('needs at least one preset', () => {
    expect(() => composePresets()).toThrow(/at least one preset/)
  })

  it('returns a single preset untouched', () => {
    const preset = definePreset({ id: 'cadastre' })
    expect(composePresets(preset)).toBe(preset)
  })

  it('deep-merges config, later wins', () => {
    const composed = composePresets(
      definePreset({
        id: 'cadastre',
        config: {
          crs: { working: 'EPSG:5254', display: 'projected', precision: 3 },
          interaction: { doubleClickZoom: false },
        },
      }),
      definePreset({ id: 'izmir', config: { crs: { precision: 4 } } }),
    )

    expect(composed.config).toEqual({
      // Untouched keys of a nested object survive — this is the whole point of a
      // deep merge, and the reason `izmir` needn't restate the CRS to retune its
      // precision.
      crs: { working: 'EPSG:5254', display: 'projected', precision: 4 },
      interaction: { doubleClickZoom: false },
    })
  })

  it('deep-merges theme, later wins', () => {
    const composed = composePresets(
      definePreset({
        id: 'base',
        theme: { id: 'light', tokens: { color: { accent: '#0af', error: '#f00' } } },
      }),
      definePreset({ id: 'dark', theme: { tokens: { color: { accent: '#111' } } } }),
    )

    expect(composed.theme).toEqual({
      id: 'light',
      tokens: { color: { accent: '#111', error: '#f00' } },
    })
  })

  it('appends validation, layers, and both middleware stacks', () => {
    const first: InteractionMiddleware = vi.fn(noopMiddleware)
    const second: InteractionMiddleware = vi.fn(noopMiddleware)

    const composed = composePresets(
      definePreset({
        id: 'cadastre',
        validation: [rule('no-overlap')],
        layers: [{ id: 'parcels', type: 'vector' }],
        interactionMiddleware: [[first, { priority: 100 }]],
        commitMiddleware: [[async (_ctx, next) => next()]],
      }),
      definePreset({
        id: 'izmir',
        validation: [rule('min-area')],
        layers: [{ id: 'zoning', type: 'vector' }],
        interactionMiddleware: [[second]],
        commitMiddleware: [[async (_ctx, next) => next()]],
      }),
    )

    expect(composed.validation?.map((r) => r.id)).toEqual(['no-overlap', 'min-area'])
    expect(composed.layers?.map((l) => l.id)).toEqual(['parcels', 'zoning'])
    expect(composed.interactionMiddleware).toHaveLength(2)
    expect(composed.interactionMiddleware?.[0]?.[1]).toEqual({ priority: 100 })
    expect(composed.commitMiddleware).toHaveLength(2)
  })

  it('appends plugins that differ', () => {
    const snapPlugin = makeFactory('snap')
    const drawPlugin = makeFactory('draw')
    const zoningPlugin = makeFactory('zoning')

    const composed = composePresets(
      definePreset({
        id: 'cadastre',
        plugins: [[snapPlugin], [drawPlugin]],
      }),
      definePreset({ id: 'izmir', plugins: [[zoningPlugin]] }),
    )

    expect(pluginIds(composed)).toEqual(['snap', 'draw', 'zoning'])
  })

  /* ----------------------------------------------------------------------- */
  /* The subtle one                                                            */
  /* ----------------------------------------------------------------------- */

  it('deep-merges the options of a repeated plugin into the existing entry, IN PLACE', () => {
    const snapPlugin = makeFactory('snap')
    const drawPlugin = makeFactory('draw')

    const composed = composePresets(
      definePreset({
        id: 'cadastre',
        plugins: [
          [
            snapPlugin,
            { tolerance: 12, providers: ['vertex', 'edge'], grid: { size: 1, enabled: true } },
          ],
          [drawPlugin, { tolerance: 1 }],
        ],
      }),
      // A municipality retuning the snap tolerance. It must not have to restate the
      // provider list — and it must not push snap to the back of the install order,
      // where a plugin depending on it would find it too late.
      definePreset({
        id: 'izmir',
        plugins: [[snapPlugin, { tolerance: 8, grid: { size: 0.5 } }]],
      }),
    )

    expect(pluginIds(composed)).toEqual(['snap', 'draw'])
    expect(optionsFor(composed, 'snap')).toEqual({
      tolerance: 8, // retuned
      providers: ['vertex', 'edge'], // inherited, not restated
      grid: { size: 0.5, enabled: true }, // deep, not shallow
    })
    expect(optionsFor(composed, 'draw')).toEqual({ tolerance: 1 })
  })

  it('merges the options of a repeated plugin across three presets', () => {
    const snapPlugin = makeFactory('snap')

    const composed = composePresets(
      definePreset({
        id: 'a',
        plugins: [[snapPlugin, { tolerance: 12, providers: ['vertex'] }]],
      }),
      definePreset({ id: 'b', plugins: [[snapPlugin, { tolerance: 10 }]] }),
      definePreset({ id: 'c', plugins: [[snapPlugin, { grid: { size: 2 } }]] }),
    )

    expect(composed.plugins).toHaveLength(1)
    expect(optionsFor(composed, 'snap')).toEqual({
      tolerance: 10,
      providers: ['vertex'],
      grid: { size: 2 },
    })
  })

  it('hands the merged options to the factory at install time, not the base preset’s', () => {
    const snapPlugin = makeFactory('snap')

    const composed = composePresets(
      definePreset({ id: 'cadastre', plugins: [[snapPlugin, { tolerance: 12 }]] }),
      definePreset({ id: 'izmir', plugins: [[snapPlugin, { tolerance: 8 }]] }),
    )

    snapPlugin.calls.length = 0
    normalisePluginSpec(composed.plugins![0]!)

    // The tuple survived composition un-invoked, so the factory sees the *final*
    // options. Had composition eagerly constructed the plugin, the retune would have
    // reached `ctx.options` and never reached the plugin's own closure.
    expect(snapPlugin.calls).toEqual([{ tolerance: 8 }])
  })

  it('replaces the implementation but keeps the merged options when a later preset swaps a plugin', () => {
    const ourSnap = makeFactory('snap')
    const theirSnap = makeFactory('snap')

    const composed = composePresets(
      definePreset({
        id: 'cadastre',
        plugins: [[ourSnap, { tolerance: 12, providers: ['vertex'] }]],
      }),
      definePreset({ id: 'in-house', plugins: [[theirSnap, { tolerance: 8 }]] }),
    )

    ourSnap.calls.length = 0
    theirSnap.calls.length = 0
    normalisePluginSpec(composed.plugins![0]!)

    expect(ourSnap.calls).toEqual([])
    expect(theirSnap.calls).toEqual([{ tolerance: 8, providers: ['vertex'] }])
  })

  it('merges a tuple over a plugin object of the same id', () => {
    const snapPlugin = makeFactory('snap')

    const composed = composePresets(
      definePreset({ id: 'base', plugins: [pluginObject('snap')] }),
      definePreset({ id: 'tuned', plugins: [[snapPlugin, { tolerance: 8 }]] }),
    )

    expect(pluginIds(composed)).toEqual(['snap'])
    expect(optionsFor(composed, 'snap')).toEqual({ tolerance: 8 })
  })

  /* ----------------------------------------------------------------------- */

  it('merges i18n per locale, later wins per key', () => {
    const composed = composePresets(
      definePreset({
        id: 'cadastre',
        i18n: {
          tr: { 'draw.polygon': 'Poligon çiz', 'parcel.area': 'Yüzölçümü' },
          en: { 'draw.polygon': 'Draw polygon' },
        },
      }),
      definePreset({ id: 'izmir', i18n: { tr: { 'draw.polygon': 'Parsel çiz' }, de: { x: 'y' } } }),
    )

    expect(composed.i18n).toEqual({
      // The overridden key wins; its neighbours in the same locale survive.
      tr: { 'draw.polygon': 'Parsel çiz', 'parcel.area': 'Yüzölçümü' },
      en: { 'draw.polygon': 'Draw polygon' },
      de: { x: 'y' },
    })
  })

  it('takes id, description and locale from the later preset', () => {
    const composed = composePresets(
      definePreset({ id: 'cadastre', description: 'national', locale: 'tr' }),
      definePreset({ id: 'izmir', locale: 'en' }),
    )

    expect(composed.id).toBe('izmir')
    expect(composed.locale).toBe('en')
    // Not restated by the later preset, so the base's survives.
    expect(composed.description).toBe('national')
  })

  it('does not mutate the presets it composes', () => {
    const snapPlugin = makeFactory('snap')
    const base = definePreset({
      id: 'cadastre',
      config: { crs: { precision: 3 } },
      validation: [rule('no-overlap')],
      plugins: [[snapPlugin, { tolerance: 12 }]],
    })

    composePresets(
      base,
      definePreset({
        id: 'izmir',
        config: { crs: { precision: 4 } },
        validation: [rule('min-area')],
        plugins: [[snapPlugin, { tolerance: 8 }]],
      }),
    )

    // A preset is a value. Composing it twice must give the same answer twice, which
    // it cannot if composition edited the base in place.
    expect(base.config).toEqual({ crs: { precision: 3 } })
    expect(base.validation).toHaveLength(1)
    expect(optionsFor(base, 'snap')).toEqual({ tolerance: 12 })
  })

  it('validates the composed result', () => {
    // Two *different* plugins that claim the same id: composition merges them into
    // one entry rather than installing the id twice, so the result stays valid.
    const composed = composePresets(
      definePreset({ id: 'a', plugins: [pluginObject('snap')] }),
      definePreset({ id: 'b', plugins: [pluginObject('snap')] }),
    )
    expect(pluginIds(composed)).toEqual(['snap'])
  })
})

/* ------------------------------------------------------------------------- */
/* overridePreset                                                              */
/* ------------------------------------------------------------------------- */

describe('overridePreset', () => {
  it('replaces rather than appends', () => {
    const base = definePreset({
      id: 'cadastre',
      validation: [rule('no-overlap'), rule('min-area')],
      layers: [{ id: 'parcels', type: 'vector' }],
    })

    const demo = overridePreset(base, { id: 'demo', validation: [] })

    expect(demo.validation).toEqual([])
    // Untouched keys are inherited whole.
    expect(demo.layers?.map((l) => l.id)).toEqual(['parcels'])
    expect(demo.id).toBe('demo')
    // And the base is untouched.
    expect(base.validation).toHaveLength(2)
  })

  it('replaces config wholesale rather than deep-merging it', () => {
    const base = definePreset({
      id: 'cadastre',
      config: { crs: { working: 'EPSG:5254', precision: 3 } },
    })

    const overridden = overridePreset(base, { config: { crs: { precision: 4 } } })

    // The distinction from composePresets, and the reason both exist: `working` is
    // *gone*, because override means "throw the base's value away".
    expect(overridden.config).toEqual({ crs: { precision: 4 } })
  })

  it('ignores keys explicitly set to undefined', () => {
    const base = definePreset({ id: 'cadastre', locale: 'tr', validation: [rule('no-overlap')] })

    // `exactOptionalPropertyTypes` rejects this literal at compile time, which is
    // exactly right — and precisely why the cast is here. The overrides object is
    // often *built at runtime* (spread from a partially-filled form, parsed from a
    // JSON config), and a spread of an unset optional carries the key with an
    // `undefined` value. That must not erase the base's locale.
    const overrides = {
      locale: undefined,
      validation: [rule('min-area')],
    } as unknown as Partial<Preset>
    const overridden = overridePreset(base, overrides)

    expect(overridden.locale).toBe('tr')
    expect(overridden.validation?.map((r) => r.id)).toEqual(['min-area'])
  })
})
