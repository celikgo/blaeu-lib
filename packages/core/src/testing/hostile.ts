/**
 * Geometry that a real import produces and a type signature does not stop.
 *
 * Every value here is typed `Geometry` and is not one. That is the whole point, and it is not
 * a contrivance: a cadastral tool ingests third-party GeoJSON — municipal exports, shapefile
 * and DXF conversions, ArcGIS dumps — and the idiom for reading it is
 *
 * ```ts
 * const parsed = JSON.parse(text) as FeatureCollection
 * ```
 *
 * which asserts a shape nobody checked. So the casts below are not the test cheating past the
 * type system; they are the test *reproducing the one line every consumer writes*. A gate that
 * only holds when the input is already well-typed is not a gate.
 *
 * Not exported from `@blaeu/core/testing`. These are for this repo's own robustness suites; if
 * a plugin author ever wants them, publishing is a deliberate decision, not a side effect.
 */

import type { Geometry, Position } from 'geojson'

/** `{"type":"Circle"}` — what Leaflet.Draw and several DXF converters emit for a circle. */
export const UNKNOWN_TYPE = {
  type: 'Circle',
  coordinates: [32.85, 39.93],
  radius: 25,
} as unknown as Geometry

/** RFC 7946 type names are case-sensitive. Hand-rolled writers routinely get this wrong. */
export const LOWERCASE_TYPE = {
  type: 'polygon',
  coordinates: [
    [
      [32.85, 39.93],
      [32.851, 39.93],
      [32.851, 39.931],
      [32.85, 39.93],
    ],
  ],
} as unknown as Geometry

/** GeoJSON explicitly allows `"geometry": null`. The store explicitly does not. */
export const NULL_GEOMETRY = null as unknown as Geometry

/** A key omitted entirely, which `JSON.parse` yields as `undefined` rather than `null`. */
export const MISSING_GEOMETRY = undefined as unknown as Geometry

/** A ring of two distinct corners — a line pretending to be an area. */
export const TWO_POINT_RING = {
  type: 'Polygon',
  coordinates: [
    [
      [32.85, 39.93],
      [32.851, 39.931],
      [32.85, 39.93],
    ],
  ],
} as unknown as Geometry

/** Coordinates that survive JSON round-tripping through some producers as strings. */
export const NON_FINITE = {
  type: 'Point',
  coordinates: [Number.NaN, 39.93],
} as unknown as Geometry

/** A polygon whose ring is present but empty. */
export const EMPTY_RING = {
  type: 'Polygon',
  coordinates: [[]],
} as unknown as Geometry

/** A valid, closed, counter-clockwise square, as a control. Coordinates are degrees. */
export function square(west: number, south: number, side: number): Geometry {
  const ring: Position[] = [
    [west, south],
    [west + side, south],
    [west + side, south + side],
    [west, south + side],
    [west, south],
  ]
  return { type: 'Polygon', coordinates: [ring] }
}

/** The same square, wrapped the way an ArcGIS or DXF converter wraps a parcel's rings. */
export function squareInCollection(west: number, south: number, side: number): Geometry {
  return { type: 'GeometryCollection', geometries: [square(west, south, side)] }
}
