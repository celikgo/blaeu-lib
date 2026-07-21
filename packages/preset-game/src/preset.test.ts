import { describe, expect, it } from 'vitest'
import { normalisePluginSpec, type Preset } from '@blaeu/core'

import { gameMapPreset } from './preset.js'
import { RULE_IN_BOUNDS, RULE_TILE_OCCUPIED } from './validation.js'
import { TILE_GRID_TYPE } from './plugins/tileGrid.js'
import { crsDecimalPlaces } from './options.js'

/* ------------------------------------------------------------------------- */
/* Helpers — a preset is a value, so testing it is asserting on that value     */
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

/**
 * The preset, with every function replaced by a marker.
 *
 * A preset is data, but not *only* data: a `ValidationRule` carries a `check`, and a
 * plugin spec carries the factory. The factories are module-level and so are
 * reference-equal between calls; a rule's `check` is a fresh closure over the resolved
 * options and cannot be, ever, by any implementation. So "pure data" has to mean
 * "deep-equal once the closures are identified by name" — and everything the closures
 * close over (the severities, the bounds, the grid) is data that this comparison *does*
 * see. Their behaviour is pinned by the integration tests.
 */
function plain(value: unknown): unknown {
  if (typeof value === 'function') return `[fn ${value.name || 'anonymous'}]`
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
  }
  return value
}

/* ------------------------------------------------------------------------- */
/* 1. The preset is pure data                                                  */
/* ------------------------------------------------------------------------- */

describe('gameMapPreset is a value, not a machine', () => {
  it('is a plain object with no prototype of its own', () => {
    const preset = gameMapPreset()

    expect(preset.id).toBe('game-map')
    expect(Object.getPrototypeOf(preset)).toBe(Object.prototype)
  })

  /**
   * The claim preset rule 1 actually makes: two calls produce the *same value*.
   *
   * Deep equality catches the failures that matter and that a shape snapshot would
   * miss — a `Date.now()` stamped into a layer config, an id minted from a counter, a
   * module-level array mutated by the last call. A preset that fails this cannot be
   * composed, cached, serialised or reasoned about, and the failure would surface as
   * "the second map on the page behaves differently".
   */
  it('returns deep-equal objects when called twice with the same options', () => {
    const a = gameMapPreset({ gridSize: 16, gridType: 'hex' })
    const b = gameMapPreset({ gridSize: 16, gridType: 'hex' })

    expect(plain(a)).toEqual(plain(b))
    // The plugin factories really are reference-equal: they are module-level functions,
    // so `composePresets` can match a spec by its factory and retune it in place.
    expect(normalisePluginSpec(a.plugins![0]!).plugin.id).toBe(
      normalisePluginSpec(b.plugins![0]!).plugin.id,
    )
    // Equal, and not the same object: two maps on one page must not share a config
    // object either, or one's `overridePreset` would rewrite the other's.
    expect(a).not.toBe(b)
    expect(a.layers).not.toBe(b.layers)
  })

  /**
   * No DOM, no globals, no clock, no randomness.
   *
   * Vitest runs this workspace in the `node` environment, so `document` and `window`
   * are genuinely absent — a preset that reached for either would throw here rather
   * than merely be impure. This test pins that: it asserts the construction is
   * *complete* (a preset that lazily touched the DOM at map-build time would still
   * pass, which is why the integration tests below build a real map in the same
   * environment).
   */
  it('touches no DOM and no globals', () => {
    expect(typeof document).toBe('undefined')
    expect(typeof window).toBe('undefined')
    expect(() => gameMapPreset()).not.toThrow()
  })

  it('mutating what one call returned does not affect the next', () => {
    const first = gameMapPreset()
    ;(first.layers as unknown[]).length = 0

    expect(gameMapPreset().layers).toHaveLength(3)
  })
})

/* ------------------------------------------------------------------------- */
/* 1b. The shape                                                               */
/* ------------------------------------------------------------------------- */

describe('gameMapPreset — shape', () => {
  it('installs the plugin set, in install order', () => {
    // `game-world` first: everything below is expressed in its units, and both
    // `game-grid` and `game-entity` hard-depend on it.
    expect(pluginIds(gameMapPreset())).toEqual([
      'game-world',
      'game-grid',
      'snap',
      'game-entity',
      'draw',
      'select',
      'history',
      'ui',
    ])
  })

  it('installs no topology plugin — a level has no cadastre', () => {
    // The bundle does not carry JSTS. This is the "you do not pay for what you do not
    // use" claim, and it is only true because topology is a plugin.
    expect(pluginIds(gameMapPreset())).not.toContain('topology')
    expect(pluginIds(gameMapPreset())).not.toContain('measure')
  })

  it('configures snapping as grid-only, and nothing else', () => {
    const snap = optionsFor(gameMapPreset({ gridSize: 64 }), 'snap')

    // Vertex/edge/midpoint/intersection are meaningless on a tile map and would fight
    // the grid for the pointer. Same plugin as cadastre; opposite configuration.
    expect(snap['providers']).toEqual(['grid'])
    expect(snap['gridSize']).toBe(64)
    expect(snap['tolerance']).toBe(16)
  })

  it('drops the built-in square grid provider on a hex world', () => {
    // The built-in `grid` provider is a *square* lattice; on a hex world the hex-centre
    // provider tileGridPlugin registers owns snapping, and the square one would fight it
    // for the pointer at the same priority. So a hex world installs no built-in provider.
    const hex = optionsFor(gameMapPreset({ gridSize: 64, gridType: 'hex' }), 'snap')
    expect(hex['providers']).toEqual([])
    // The plugin is still installed — it must be, for tileGridPlugin to register into it.
    expect(pluginIds(gameMapPreset({ gridType: 'hex' }))).toContain('snap')
  })

  /**
   * `working` must be absent, and that absence is load-bearing.
   *
   * `BlaeuCrsService` is built from `config.crs` in the `BlaeuMap` constructor, before
   * any plugin's setup runs, and it throws on a code it does not know. Naming
   * `GAME:WORLD` here would kill every map this preset builds — which is exactly what
   * it used to do. `worldCrsPlugin` registers the plane and calls `setWorking()`.
   */
  it('does not name the world CRS in config — it is not registered yet', () => {
    expect(gameMapPreset().config?.crs).toEqual({
      display: 'projected',
      precision: 3,
    })
    expect(gameMapPreset().config?.crs).not.toHaveProperty('working')
  })

  it('converts the world-unit precision grid into the decimal places the kernel wants', () => {
    // The kernel rejects a grid handed to it as a place count, with a message saying so.
    // 0.001 units → 3 places; the two quantities are not interchangeable.
    expect(crsDecimalPlaces(0.001)).toBe(3)
    expect(crsDecimalPlaces(1)).toBe(0)
    expect(gameMapPreset({ precision: 0.01 }).config?.crs?.precision).toBe(2)
  })

  it('turns double-click zoom off — a double-click is a placement gesture here', () => {
    expect(gameMapPreset().config?.interaction?.doubleClickZoom).toBe(false)
  })

  it('declares the grid as a custom layer type, under the zones and the entities', () => {
    expect((gameMapPreset().layers ?? []).map((l) => ({ id: l.id, type: l.type }))).toEqual([
      { id: 'game-grid', type: TILE_GRID_TYPE },
      { id: 'game-zones', type: 'vector' },
      { id: 'game-entities-entities', type: 'vector' },
    ])
  })

  it('gives an EntityType with its own layer a layer of its own', () => {
    const preset = gameMapPreset({
      entities: [
        { id: 'tree', label: 'Tree', icon: '🌲' },
        { id: 'spawn', label: 'Spawn', icon: '🚩', layer: 'markers' },
      ],
    })

    expect((preset.layers ?? []).map((l) => l.id)).toEqual([
      'game-grid',
      'game-zones',
      'game-entities-entities',
      'game-entities-markers',
    ])
  })

  it('declares the bounds rule as an error and tile occupancy as a warning', () => {
    expect(severities(gameMapPreset())).toEqual({
      [RULE_IN_BOUNDS]: 'error',
      [RULE_TILE_OCCUPIED]: 'warning',
    })
  })

  /**
   * The whole preset argument in one option: a tower-defence game where a tile holds
   * exactly one tower promotes the rule to `error` and gets the block for free —
   * without a line of the kernel, the plugins or this preset changing.
   */
  it('lets a game promote tile occupancy to a hard error, or remove it entirely', () => {
    expect(severities(gameMapPreset({ occupancySeverity: 'error' }))[RULE_TILE_OCCUPIED]).toBe(
      'error',
    )
    expect(Object.keys(severities(gameMapPreset({ occupancySeverity: 'off' })))).toEqual([
      RULE_IN_BOUNDS,
    ])
  })

  it('drops the UI plugin when the host brings its own chrome', () => {
    expect(pluginIds(gameMapPreset({ ui: false }))).not.toContain('ui')
  })

  it('is a snapshot of a data structure, and that is the whole point', () => {
    const preset = gameMapPreset()

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
          "precision": 3,
        },
        "id": "game-map",
        "layers": [
          {
            "id": "game-grid",
            "source": undefined,
            "type": "tile-grid",
          },
          {
            "id": "game-zones",
            "source": "zones",
            "type": "vector",
          },
          {
            "id": "game-entities-entities",
            "source": "entities",
            "type": "vector",
          },
        ],
        "locale": "en",
        "locales": [
          "en",
          "tr",
        ],
        "plugins": [
          "game-world",
          "game-grid",
          "snap",
          "game-entity",
          "draw",
          "select",
          "history",
          "ui",
        ],
        "themeId": "blaeu-game",
        "validation": {
          "game.entity.inBounds": "error",
          "game.entity.tileOccupied": "warning",
        },
      }
    `)
  })
})

/* ------------------------------------------------------------------------- */
/* Options that must fail loudly                                               */
/* ------------------------------------------------------------------------- */

describe('gameMapPreset — options it refuses', () => {
  it('rejects a zero gridSize, and says what to set instead', () => {
    expect(() => gameMapPreset({ gridSize: 0 })).toThrow(/gridSize must be a positive number/)
  })

  it('rejects an inverted bounds rectangle', () => {
    expect(() => gameMapPreset({ bounds: [100, 100, -100, -100] })).toThrow(/positive extent/)
  })

  it('rejects two entity types under one id', () => {
    expect(() =>
      gameMapPreset({
        entities: [
          { id: 'tree', label: 'Tree', icon: '🌲' },
          { id: 'tree', label: 'Pine', icon: '🌳' },
        ],
      }),
    ).toThrow(/declared twice/)
  })
})
