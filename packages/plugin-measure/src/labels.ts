import type { FeatureInput, Json } from '@blaeu/core'

import { formatLength } from './format.js'
import { ringCentroid, segmentMidpoint, type MeasureEnv } from './measurement.js'
import type { Measurement } from './types.js'

/**
 * A measurement, turned into the features that draw it.
 *
 * Labels are **derived**, not state: they are a pure function of the measurement,
 * which is itself a pure function of the geometry. That is why re-deriving them on a
 * locale change is safe, and why undoing the command that added the geometry can
 * take the labels with it without any bookkeeping — the ids are deterministic.
 */

/** The geometry feature: the line or the ring itself. */
export function geometryFeature(measurement: Measurement): FeatureInput {
  return {
    id: measurement.id,
    geometry: measurement.geometry,
    properties: {
      mode: measurement.mode,
      value: measurement.value,
      label: measurement.label,
      draft: measurement.draft,
    },
  }
}

/**
 * One Point per segment at its planar midpoint, plus the total at the polygon
 * centroid (or at the last vertex of an open line).
 *
 * The running total is what makes the tool usable while it is still being drawn: the
 * rubber-band segment carries its own length before the user has committed it, which
 * is the whole reason they are dragging the pointer around in the first place.
 */
export function labelFeatures(env: MeasureEnv, measurement: Measurement): FeatureInput[] {
  const features: FeatureInput[] = []

  for (const [index, segment] of measurement.segments.entries()) {
    // A bearing measurement's one segment carries the bearing itself — not its
    // length, which nobody asked for.
    const text =
      measurement.mode === 'bearing'
        ? measurement.label
        : formatLength(segment.lengthMetres, env.options.lengthUnit, env.i18n)

    features.push({
      id: `${measurement.id}:segment:${index}`,
      geometry: {
        type: 'Point',
        coordinates: asPosition(segmentMidpoint(env, segment.from, segment.to)),
      },
      properties: base(measurement, 'segment', text, segment.lengthMetres),
    })
  }

  // A bearing is already stated on its only segment; a second, identical label
  // stacked on top of it is just a heavier line.
  if (measurement.mode !== 'bearing') {
    features.push({
      id: `${measurement.id}:total`,
      geometry: { type: 'Point', coordinates: asPosition(totalAnchor(env, measurement)) },
      properties: base(measurement, 'total', measurement.label, measurement.value),
    })
  }

  return features
}

/** Ids the label features of `measurement` would occupy. Used to remove them. */
export function labelIds(measurement: Measurement): string[] {
  const ids = measurement.segments.map((_, index) => `${measurement.id}:segment:${index}`)
  if (measurement.mode !== 'bearing') ids.push(`${measurement.id}:total`)
  return ids
}

function totalAnchor(env: MeasureEnv, measurement: Measurement) {
  const closed = measurement.geometry.type === 'Polygon'
  if (closed) return ringCentroid(env, measurement.positions)
  // An open line's total belongs at its head — where the pointer is, mid-gesture.
  return measurement.positions.at(-1) ?? measurement.positions[0]!
}

function base(
  measurement: Measurement,
  kind: 'segment' | 'total',
  label: string,
  value: number,
): Record<string, Json> {
  return {
    measurement: measurement.id,
    mode: measurement.mode,
    kind,
    label,
    value,
    draft: measurement.draft,
  }
}

function asPosition(lngLat: readonly [number, number]): number[] {
  return [lngLat[0], lngLat[1]]
}
