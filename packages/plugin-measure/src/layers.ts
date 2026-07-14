import type { LayerSpec, LayerStyle, ThemeManager } from '@fleximap/core'

import {
  DRAFT_COLLECTION,
  DRAFT_LABEL_COLLECTION,
  LABEL_COLLECTION,
  MEASURE_COLLECTION,
} from './types.js'

/**
 * Everything the plugin paints, styled **from theme tokens only**.
 *
 * Not one colour is hardcoded. A preset that repaints the map — a pale cadastral
 * basemap, a dark game map — repaints the measurement overlay with it, and the
 * measurement accent is by construction the same accent as the selection halo. That
 * consistency is not decoration; it is what tells a user the two things are the same
 * system.
 */

export const LAYER_IDS = {
  geometry: 'measure:geometry',
  labels: 'measure:labels',
  draft: 'measure:draft',
  draftLabels: 'measure:draft-labels',
} as const

/** Layer specs in draw order: geometry under labels, committed under draft. */
export function measureLayers(theme: ThemeManager): LayerSpec[] {
  return [
    { id: LAYER_IDS.geometry, type: 'vector', source: MEASURE_COLLECTION },
    { id: LAYER_IDS.draft, type: 'vector', source: DRAFT_COLLECTION },
    { id: LAYER_IDS.labels, type: 'vector', source: LABEL_COLLECTION },
    { id: LAYER_IDS.draftLabels, type: 'vector', source: DRAFT_LABEL_COLLECTION },
  ].map((spec) => ({ ...spec, style: styleFor(spec.id, theme) }))
}

export function styleFor(layerId: string, theme: ThemeManager): LayerStyle {
  switch (layerId) {
    case LAYER_IDS.geometry:
      return geometryStyle(theme, false)
    case LAYER_IDS.draft:
      return geometryStyle(theme, true)
    case LAYER_IDS.labels:
      return labelStyle(theme, false)
    case LAYER_IDS.draftLabels:
      return labelStyle(theme, true)
    default:
      throw new Error(
        `[measure] no style for layer "${layerId}". The measure plugin owns exactly: ` +
          `${Object.values(LAYER_IDS).join(', ')}.`,
      )
  }
}

function geometryStyle(theme: ThemeManager, draft: boolean): LayerStyle {
  const color = theme.token('color')
  const size = theme.token('size')

  return {
    fill: { color: color.accent, opacity: draft ? 0.08 : 0.15 },
    line: {
      color: color.accent,
      width: size.lineWidth,
      // The rubber band is dashed and the committed line is solid, so that a user
      // glancing at the map can tell at once which of the two shapes is still theirs
      // to change.
      ...(draft ? { dasharray: [2, 2] as const, opacity: 0.9 } : {}),
    },
    circle: {
      color: color.vertex,
      radius: size.vertexRadius,
      strokeColor: color.accent,
      strokeWidth: 2,
    },
  }
}

function labelStyle(theme: ThemeManager, draft: boolean): LayerStyle {
  const color = theme.token('color')
  const font = theme.token('font')

  return {
    symbol: {
      // A MapLibre expression: the label text lives in the feature's `label`
      // property, so a re-render is a `setData`, not a style rebuild.
      text: ['get', 'label'],
      size: font.sizeSmall,
    },
    native: {
      paint: {
        'text-color': draft ? color.textMuted : color.text,
        // A halo, always. A measurement label sits *on top of* whatever the user is
        // measuring — a satellite image, a dense parcel fabric — and unhaloed text on
        // an arbitrary background is the single most common way a map label becomes
        // unreadable.
        'text-halo-color': color.surface,
        'text-halo-width': 1.5,
      },
      layout: {
        'text-anchor': 'center',
        'text-offset': [0, -0.8],
        // Measurement labels must never be dropped by collision: a segment whose
        // length is hidden because a neighbouring label got there first is a segment
        // the user has to re-measure.
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
    },
  }
}
