import { definePreset, type Preset, type Theme } from '@fleximap/core'
import { drawPlugin } from '@fleximap/plugin-draw'
import { editPlugin } from '@fleximap/plugin-edit'
import { historyPlugin } from '@fleximap/plugin-history'
import { measurePlugin } from '@fleximap/plugin-measure'
import { selectPlugin } from '@fleximap/plugin-select'
import { snapPlugin } from '@fleximap/plugin-snap'
import { topologyPlugin } from '@fleximap/plugin-topology'
import { uiPlugin } from '@fleximap/plugin-ui'

import { DERIVE_AREA_ID, DERIVE_AREA_PRIORITY, deriveAreaMiddleware } from './derive.js'
import { cadastreLayers } from './layers.js'
import { cadastreMessages } from './messages.js'
import { resolveCadastreOptions, type CadastreOptions } from './options.js'
import { cadastreTheme } from './theme.js'
import { cadastreValidation } from './validation.js'

/**
 * The Turkish cadastre preset: the kernel, plus the judgement of somebody who has
 * had a boundary dispute explained to them.
 *
 * Every plugin below is domain-agnostic — `snapPlugin` has never heard of a parcel
 * and never will. What makes this *cadastre* is the numbers and the severities on
 * this page: 12 px because a looser snap invents slivers; topological editing
 * because a shared boundary is one boundary; `autoFix: false` because the software
 * reports and the surveyor decides; overlap `error` and gap `warning` because one
 * is a dispute and the other is a slip of the mouse.
 *
 * ```ts
 * const map = await createFlexiMap({
 *   container: '#map',
 *   preset: cadastrePreset({ crs: 'EPSG:5255', locale: 'tr' }),   // Izmir belt
 * })
 * ```
 *
 * It is a pure function of its options: no DOM, no globals, no map. Call it twice
 * and you get two equal objects, which is what makes it snapshot-testable, and what
 * lets a municipality retune it with `composePresets` instead of forking it — see
 * the README.
 */
export function cadastrePreset(options: CadastreOptions = {}): Preset {
  const o = resolveCadastreOptions(options)

  const theme: Theme = {
    ...cadastreTheme,
    ...(o.basemap !== undefined ? { basemap: o.basemap } : {}),
  }

  return definePreset({
    id: 'cadastre',
    description:
      'Turkish cadastre: TUREF/TM projected working CRS, millimetre readouts, topological editing, ' +
      'parcel-to-parcel topology rules, ada/parsel attribute schema.',

    config: {
      crs: {
        working: o.crs,
        // A surveyor wants `Y=458123.456 X=4421987.123`, not a pair of decimal
        // degrees — the projected string is the one they can type back in, compare
        // against a coordinate schedule, and read out over the phone.
        display: 'projected',
        precision: o.precision,
      },
      interaction: {
        // Double-click *closes the ring*. Leaving it also zoomed would mean every
        // completed parcel throws the surveyor two zoom levels off the work.
        doubleClickZoom: false,
      },
      locale: o.locale,
    },

    plugins: [
      [
        snapPlugin,
        {
          tolerance: o.snapTolerance,
          providers: o.snapProviders,
          ...(o.gridSize !== undefined ? { gridSize: o.gridSize } : {}),
        },
      ],
      [drawPlugin, { defaultMode: 'polygon', collection: o.parcels }],
      [
        editPlugin,
        {
          // The single most important line in this file. Two parcels that share a
          // boundary must keep sharing it; a system that lets them drift 3 cm apart
          // has not produced a rendering artefact, it has produced a strip of land
          // with no owner and a court case.
          topological: true,
          handleSize: o.handleSize,
        },
      ],
      [
        topologyPlugin,
        {
          autoFix: false,
          tolerance: o.tolerance,
          sliverRatio: o.sliverRatio,
        },
      ],
      [
        measurePlugin,
        {
          areaUnit: o.areaUnit,
          lengthUnit: o.lengthUnit,
          // Planar, in the working CRS. A land registry will not accept a spherical
          // area, and it is right not to: on a 2 000 m² parcel at 39°N the two
          // answers differ by square metres.
          planar: true,
        },
      ],
      // Buildings are context, not the work. Clicking a footprint that came from an
      // orthophoto trace must not select something the surveyor cannot legally edit.
      [selectPlugin, { collections: [o.parcels] }],
      [historyPlugin, { limit: o.historyLimit }],
      [uiPlugin, { attributions: o.attributions }],
    ],

    // Area is derived, never typed — see `deriveAreaMiddleware`. Priority puts it
    // ahead of validation, so a rule that reads `yuzolcumu` reads the fresh value
    // rather than the one from before this edit.
    ...(o.deriveArea
      ? {
          commitMiddleware: [
            [
              deriveAreaMiddleware({
                crs: o.crs,
                precision: o.precision,
                collection: o.parcels,
                decimals: o.areaDecimals,
              }),
              { id: DERIVE_AREA_ID, priority: DERIVE_AREA_PRIORITY },
            ],
          ] as const,
        }
      : {}),

    validation: cadastreValidation(o),
    layers: cadastreLayers({ parcels: o.parcels, buildings: o.buildings }),
    theme,
    i18n: cadastreMessages,
    locale: o.locale,
  })
}
