import type { CollectionId, LayerSpec } from '@fleximap/core'

import { CADASTRE_COLORS } from './theme.js'

export const PARCEL_LAYER = 'parcels'
export const BUILDING_LAYER = 'buildings'
export const PARCEL_LABEL_LAYER = 'parcel-labels'

export interface CadastreLayerOptions {
  readonly parcels: CollectionId
  readonly buildings: CollectionId
}

/**
 * Three layers, in draw order: buildings, then parcels, then the ada/parsel labels.
 *
 * Buildings go *under* parcels on purpose. A building sits inside its parcel, so
 * whichever is drawn last wins the boundary pixels — and the boundary is the whole
 * document. A cadastral map where a roof outline hides a parcel edge is a map that
 * cannot be used for the one thing it exists for.
 */
export function cadastreLayers(options: CadastreLayerOptions): readonly LayerSpec[] {
  return [
    {
      id: BUILDING_LAYER,
      type: 'vector',
      source: options.buildings,
      style: {
        fill: {
          color: CADASTRE_COLORS.buildingFill,
          opacity: 0.25,
          outlineColor: CADASTRE_COLORS.buildingLine,
        },
        line: { color: CADASTRE_COLORS.buildingLine, width: 0.8, opacity: 0.8 },
      },
    },

    {
      id: PARCEL_LAYER,
      type: 'vector',
      source: options.parcels,
      style: {
        // 8 % — enough to hit-test and to read as a body, nowhere near enough to
        // compete with the outline. The parcel *is* its boundary.
        fill: {
          color: CADASTRE_COLORS.parcelFill,
          opacity: 0.08,
          outlineColor: CADASTRE_COLORS.parcelLine,
        },
        // Crisp: near-black, hairline-thin at low zoom and only slightly thicker when
        // the surveyor is at the scale where they actually place corners. A boundary
        // rendered 4 px wide is a boundary whose true position is ±2 px ambiguous.
        line: {
          color: CADASTRE_COLORS.parcelLine,
          width: ['interpolate', ['linear'], ['zoom'], 12, 0.8, 16, 1.6, 20, 2.4],
          opacity: 1,
        },
      },
    },

    {
      id: PARCEL_LABEL_LAYER,
      type: 'vector',
      source: options.parcels,
      style: {
        symbol: {
          // "102/7" — ada over parsel, exactly as it is written on a paper sheet and
          // spoken out loud. `coalesce` rather than a bare `get`, so a parcel drawn
          // ten seconds ago and not yet attributed renders as "—/—" instead of
          // vanishing: an unlabelled parcel is a to-do, and it should look like one.
          text: [
            'concat',
            ['coalesce', ['get', 'ada'], '—'],
            '/',
            ['coalesce', ['get', 'parsel'], '—'],
          ],
          size: 12,
        },
        native: {
          layout: {
            'text-font': ['Noto Sans Regular'],
            'text-anchor': 'center',
            // Never let two parcel numbers collide into an unreadable smudge; and
            // never let a *parcel* number be the label that gets dropped for a POI.
            'text-allow-overlap': false,
            'text-padding': 4,
          },
          paint: {
            'text-color': CADASTRE_COLORS.label,
            'text-halo-color': CADASTRE_COLORS.labelHalo,
            'text-halo-width': 1.2,
          },
        },
      },
    },
  ]
}
