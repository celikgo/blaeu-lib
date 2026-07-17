import { definePreset, type Preset } from '@blaeu/core'
import { drawPlugin } from '@blaeu/plugin-draw'
import { historyPlugin } from '@blaeu/plugin-history'
import { selectPlugin } from '@blaeu/plugin-select'
import { snapPlugin } from '@blaeu/plugin-snap'
import { uiPlugin } from '@blaeu/plugin-ui'

import { entityPlugin } from './plugins/entity.js'
import { tileGridPlugin } from './plugins/tileGrid.js'
import { worldCrsPlugin } from './plugins/worldCrs.js'

import { gameLayers } from './layers.js'
import { en, tr } from './messages.js'
import { crsDecimalPlaces, resolveGameOptions } from './options.js'
import { gameTheme } from './theme.js'
import { gameRules } from './validation.js'
import type { GameOptions } from './types.js'

/**
 * A game level editor, built from the same kernel as the cadastre preset.
 *
 * That claim is the reason this package exists, so it is worth being precise
 * about what is *different* here rather than what is the same:
 *
 * - **No basemap.** The world is the map. There is no Earth underneath it.
 * - **No topology plugin.** A level has no cadastral topology, so the preset simply
 *   does not install it — and the bundle does not carry JSTS. You do not pay for
 *   what you do not use, which is only true because topology was a plugin and not
 *   a core feature.
 * - **A custom CRS.** A game world is a plane in arbitrary units, not a geodetic
 *   surface. `worldCrsPlugin` registers one — and every kernel facility that does
 *   planar maths (snapping, grid quantisation, distance, area) then works on it
 *   unchanged, because they were all written against `crs.working` rather than
 *   against the Earth. See `world.ts` for the honest account of the trick and its
 *   limits.
 * - **A custom layer type.** `tile-grid` is registered by this preset, not shipped
 *   by the core.
 *
 * Snapping is grid-only and mandatory: in a tile-based editor, an entity half a
 * tile off its cell is a bug, not a choice. That is the same `snapPlugin` the
 * cadastre preset uses at 12 px with five vertex-level providers — the plugin is
 * domain-agnostic, and the judgement lives here.
 *
 * ```ts
 * const map = await createBlaeuMap({
 *   container: '#map',
 *   preset: gameMapPreset({ gridSize: 32, gridType: 'square' }),
 * })
 * ```
 *
 * Pure function of its options: no DOM, no globals, no map.
 */
export function gameMapPreset(options: GameOptions = {}): Preset {
  const o = resolveGameOptions(options)

  return definePreset({
    id: 'game-map',
    description:
      'Tile-based game level editor: custom world-units CRS, grid snapping, entity placement, ' +
      'procedural generation hooks, a custom tile-grid layer type. No basemap, no geodesy.',

    config: {
      crs: {
        // `working` is deliberately absent, and this is the one place in the preset
        // where that absence is load-bearing. `BlaeuCrsService` is constructed from
        // `config.crs` in the `BlaeuMap` constructor, *before* any plugin's setup runs,
        // and it throws on a code it does not know — so naming `GAME:WORLD` here would
        // kill the map before `worldCrsPlugin` ever got the chance to register it. The
        // plugin calls `crs.setWorking()` instead, in the few milliseconds before
        // anything has been measured or ingested. See `plugins/worldCrs.ts`.
        //
        // World units, not degrees and not a survey grid — so show the designer the
        // number they actually think in: `x=128 y=-64`.
        display: 'projected',
        // `CrsConfig.precision` is **decimal places**; `GameOptions.precision` is a
        // **grid in world units** (a millitile). They are different quantities and the
        // confusion between them is silent, so the conversion is explicit here rather
        // than hopeful. The registered world plane carries the grid itself — see
        // `worldCrsSpec` — and that is what actually quantises the store.
        precision: crsDecimalPlaces(o.precision),
      },
      interaction: {
        // Double-click is a placement gesture in a level editor. A zoom on top of it
        // would fight the user on every second entity.
        doubleClickZoom: false,
      },
      locale: o.locale,
    },

    plugins: [
      // First: the world plane. Everything below is expressed in its units, and the
      // entity plugin hard-depends on it.
      [worldCrsPlugin, options],
      [tileGridPlugin, options],

      // Grid-only snapping. The other providers (vertex, edge, midpoint,
      // intersection) are meaningless on a tile map and would fight the grid for
      // the pointer — so they are simply not enabled. Same plugin as cadastre;
      // opposite configuration.
      [
        snapPlugin,
        {
          tolerance: o.snapTolerance,
          providers: ['grid'],
          gridSize: o.gridSize,
        },
      ],

      [entityPlugin, options],

      // Zones are the designer's own polygons — triggers, spawn regions, nav areas.
      [drawPlugin, { defaultMode: 'polygon', collection: o.zoneCollection }],
      [selectPlugin, { collections: [o.collection, o.zoneCollection] }],

      // Shallow, deliberately. A level editor's undo is a working memory, not an
      // audit trail — unlike the cadastre preset, where 200 steps of history is a
      // record of who moved which boundary.
      [historyPlugin, { limit: o.historyLimit }],

      ...(o.ui ? [[uiPlugin, { attributions: o.attributions }] as const] : []),
    ],

    // Bounds and tile-occupancy checks. Note these are *the same mechanism* the
    // cadastre preset uses to reject a self-intersecting parcel — a ValidationRule
    // running in the commit pipeline. The kernel does not know one is about land
    // law and the other about whether two rocks are stacked on one tile.
    validation: gameRules(o),

    layers: gameLayers(o),
    theme: gameTheme(o),
    i18n: { en, tr },
    locale: o.locale,
  })
}
