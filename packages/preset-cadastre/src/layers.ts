import type { CollectionId, LayerSpec, ThemeStyleFn } from '@blaeu/core'

import { CADASTRE_COLORS } from './theme.js'

/**
 * The parcel outline + fill, as a function of the theme.
 *
 * Hoisted to a module constant rather than built inside {@link cadastreLayers} so two
 * `cadastrePreset()` calls share the *same* function reference — a preset must be a
 * pure, comparable value (it is shipped as config), and two fresh arrow functions
 * would never be equal. It closes over nothing, so there is nothing per-call to close.
 */
const parcelStyle: ThemeStyleFn = (t) => ({
  // 8 % — enough to hit-test and to read as a body, nowhere near enough to compete
  // with the outline. The parcel *is* its boundary.
  fill: { color: t.color.accent, opacity: 0.08, outlineColor: t.color.accent },
  // Crisp: the theme's accent (near-black under the survey palette), hairline-thin at
  // low zoom and only slightly thicker when the surveyor is at the scale where they
  // actually place corners. A boundary rendered 4 px wide is a boundary whose true
  // position is ±2 px ambiguous.
  line: {
    color: t.color.accent,
    width: ['interpolate', ['linear'], ['zoom'], 12, 0.8, 16, 1.6, 20, 2.4],
    opacity: 1,
  },
})

/** The ada/parsel labels, as a function of the theme — text colour and a ground-coloured halo. */
const parcelLabelStyle: ThemeStyleFn = (t) => ({
  symbol: {
    // "102/7" — ada over parsel, exactly as it is written on a paper sheet and spoken
    // out loud. `coalesce` rather than a bare `get`, so a parcel drawn ten seconds ago
    // and not yet attributed renders as "—/—" instead of vanishing: an unlabelled
    // parcel is a to-do, and it should look like one.
    text: ['concat', ['coalesce', ['get', 'ada'], '—'], '/', ['coalesce', ['get', 'parsel'], '—']],
    size: 12,
  },
  native: {
    layout: {
      'text-font': ['Noto Sans Regular'],
      'text-anchor': 'center',
      // Never let two parcel numbers collide into an unreadable smudge; and never let
      // a *parcel* number be the label that gets dropped for a POI.
      'text-allow-overlap': false,
      'text-padding': 4,
    },
    paint: {
      // The label reads the theme's text colour, and — the detail that keeps it legible
      // after a dark switch — a halo the colour of the map ground.
      'text-color': t.color.text,
      'text-halo-color': t.color.labelHalo,
      'text-halo-width': 1.2,
    },
  },
})

/**
 * The parcel fabric follows the theme.
 *
 * Colours are read from the live tokens rather than baked in, so switching the theme
 * re-tints the boundaries with everything else: under the cadastre theme the tokens
 * *are* the survey palette (nothing moves), but switch to a dark theme and the parcel
 * line takes the dark theme's accent, the label its text colour, and — the detail
 * that matters — the label halo flips dark, instead of leaving a white smear on a
 * dark map. Building colours stay fixed: a roof is brown on any theme, and it is
 * deliberately not competing with the boundary for the eye.
 */

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
      style: parcelStyle,
    },

    {
      id: PARCEL_LABEL_LAYER,
      type: 'vector',
      source: options.parcels,
      style: parcelLabelStyle,
    },
  ]
}
