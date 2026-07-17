import type { LngLat } from '../types/common.js'
import type { FeatureInput, Position } from '../types/feature.js'

/**
 * Geometry fixtures — **nasty by default**, because nasty is what production sends.
 *
 * Everything here is EPSG:4326 near Ankara (32.85, 39.93), which puts it inside
 * TUREF / TM30 (EPSG:5254) — the working CRS a Turkish cadastre preset actually
 * uses. Fixtures on the null island would let a projection bug hide, because
 * everything is small and well-behaved at [0, 0].
 */

/** Kızılay, Ankara. The origin every fixture is measured from. */
export const ANKARA: LngLat = [32.85, 39.93]

/** A realistic urban parcel: 50 m × 40 m = 2 000 m². */
export const PARCEL_WIDTH_M = 50
export const PARCEL_HEIGHT_M = 40

export interface ParcelOptions {
  readonly origin?: LngLat
  readonly widthMetres?: number
  readonly heightMetres?: number
}

/* ========================================================================= */
/* Local geodesy                                                             */
/* ========================================================================= */

/*
 * Fixtures are stated in metres and converted to degrees here, so that
 * `sliverParcels()` can be honest about being *0.4 mm* apart rather than about
 * being 4.7e-9 degrees apart — a number nobody can sanity-check by eye.
 *
 * The conversion uses the standard WGS84 local-scale series, evaluated **once at
 * the fixture's origin latitude** and then held fixed. That makes the fixture a
 * flat metre grid anchored at the origin: not geodetically exact a hundred
 * kilometres away, but exactly reproducible to the last bit — which is what a
 * fixture needs, and why two parcels can share a corner *identically* rather than
 * to within a rounding error.
 */

/** Metres per degree of latitude at `lat`. */
export function metresPerDegreeLat(lat: number): number {
  const φ = (lat * Math.PI) / 180
  return 111132.92 - 559.82 * Math.cos(2 * φ) + 1.175 * Math.cos(4 * φ) - 0.0023 * Math.cos(6 * φ)
}

/** Metres per degree of longitude at `lat`. */
export function metresPerDegreeLng(lat: number): number {
  const φ = (lat * Math.PI) / 180
  return 111412.84 * Math.cos(φ) - 93.5 * Math.cos(3 * φ) + 0.118 * Math.cos(5 * φ)
}

/** `origin` displaced by a metric offset. Deterministic: same inputs, same bits. */
export function offsetMetres(origin: LngLat, eastMetres: number, northMetres: number): LngLat {
  const lat = origin[1]
  return [
    origin[0] + eastMetres / metresPerDegreeLng(lat),
    origin[1] + northMetres / metresPerDegreeLat(lat),
  ]
}

/**
 * Planar distance in metres between two nearby coordinates.
 *
 * Local-scale, not geodesic — good to well under a millimetre over the hundreds of
 * metres a test cares about, and it needs no dependency. Anything a *surveyor*
 * signs must still go through `map.crs.working` (core invariant 3); this is for
 * assertions, not for cadastre.
 */
export function distanceMetres(a: LngLat, b: LngLat): number {
  const lat = (a[1] + b[1]) / 2
  const dx = (a[0] - b[0]) * metresPerDegreeLng(lat)
  const dy = (a[1] - b[1]) * metresPerDegreeLat(lat)
  return Math.hypot(dx, dy)
}

/* ========================================================================= */
/* Fixtures                                                                  */
/* ========================================================================= */

/**
 * A clean rectangular parcel of ~2 000 m². The happy path.
 *
 * The ring is closed and wound counter-clockwise, as RFC 7946 requires of an
 * exterior ring — so a test that *fails* on winding order is telling you about
 * your code, not about the fixture.
 */
export function parcelFixture(id = 'parcel-1', options: ParcelOptions = {}): FeatureInput {
  const origin = options.origin ?? ANKARA
  const width = options.widthMetres ?? PARCEL_WIDTH_M
  const height = options.heightMetres ?? PARCEL_HEIGHT_M

  return {
    id,
    geometry: { type: 'Polygon', coordinates: [rectangleRing(origin, width, height)] },
    properties: { ada: '1234', parsel: id, yuzolcumu: Math.round(width * height) },
  }
}

/**
 * Two parcels sharing a boundary **exactly** — the topology workhorse.
 *
 * The shared corners are the identical `LngLat` values in both rings, bit for bit,
 * so the topology index must resolve them to one key with two `VertexRef`s and
 * moving that corner must move both parcels in a single command. If it ever moves
 * one of them, adjacent parcels have started to drift apart, which in a land
 * registry is a legal problem rather than a rendering artefact.
 */
export function sharedEdgeParcels(): readonly [FeatureInput, FeatureInput] {
  const origin = ANKARA
  const w = PARCEL_WIDTH_M
  const h = PARCEL_HEIGHT_M

  // Compute the shared corners once and reuse them, rather than recomputing the
  // same expression in both rings and trusting float determinism to make them equal.
  const sharedSouth = offsetMetres(origin, w, 0)
  const sharedNorth = offsetMetres(origin, w, h)

  const left: FeatureInput = {
    id: 'parcel-left',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          toPosition(origin),
          toPosition(sharedSouth),
          toPosition(sharedNorth),
          toPosition(offsetMetres(origin, 0, h)),
          toPosition(origin),
        ],
      ],
    },
    properties: { ada: '1234', parsel: '1' },
  }

  const right: FeatureInput = {
    id: 'parcel-right',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          toPosition(sharedSouth),
          toPosition(offsetMetres(origin, 2 * w, 0)),
          toPosition(offsetMetres(origin, 2 * w, h)),
          toPosition(sharedNorth),
          toPosition(sharedSouth),
        ],
      ],
    },
    properties: { ada: '1234', parsel: '2' },
  }

  return [left, right]
}

/**
 * Two parcels sharing a boundary **almost** exactly: 0.4 mm apart.
 *
 * This is the sliver test, and it is the one that catches a refactor. 0.4 mm is
 * below the 1 mm precision grid of a cadastral working CRS, so quantisation on
 * ingest must collapse the two corners into one, and both the snap engine and the
 * topology index must treat them as a single corner. If this test starts failing,
 * something has stopped quantising — and slivers are back.
 */
export function sliverParcels(): readonly [FeatureInput, FeatureInput] {
  const origin = ANKARA
  const w = PARCEL_WIDTH_M
  const h = PARCEL_HEIGHT_M
  const gap = 0.0004 // metres — 0.4 mm

  const left = parcelFixture('parcel-left', { origin })
  const right: FeatureInput = {
    id: 'parcel-right',
    geometry: {
      type: 'Polygon',
      coordinates: [rectangleRing(offsetMetres(origin, w + gap, 0), w, h)],
    },
    properties: { ada: '1234', parsel: '2' },
  }

  return [left, right]
}

/**
 * A bowtie: the ring crosses itself. Validation must reject it *and* name the
 * offending coordinate — "invalid geometry" alone leaves a surveyor hunting
 * through 400 vertices.
 */
export function selfIntersectingRing(id = 'bowtie'): FeatureInput {
  const origin = ANKARA
  const w = PARCEL_WIDTH_M
  const h = PARCEL_HEIGHT_M

  return {
    id,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          toPosition(origin),
          toPosition(offsetMetres(origin, w, h)), // cross to the far corner…
          toPosition(offsetMetres(origin, w, 0)), // …and back: the bowtie
          toPosition(offsetMetres(origin, 0, h)),
          toPosition(origin),
        ],
      ],
    },
    properties: {},
  }
}

/**
 * Consecutive identical coordinates. Nobody ever meant this, so it must be cleaned
 * silently on ingest — not left to blow up a boolean op three operations later,
 * where the stack trace points at the wrong code entirely.
 */
export function duplicateVertexRing(id = 'duplicate-vertex'): FeatureInput {
  const origin = ANKARA
  const w = PARCEL_WIDTH_M
  const h = PARCEL_HEIGHT_M

  const sw = origin
  const se = offsetMetres(origin, w, 0)
  const ne = offsetMetres(origin, w, h)
  const nw = offsetMetres(origin, 0, h)

  // Each `toPosition` call allocates a fresh array: the duplicates must be *equal*,
  // not *identical*. Aliasing one array into two ring slots would let an in-place
  // cleaner appear to work by mutating both at once.
  return {
    id,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          toPosition(sw),
          toPosition(sw),
          toPosition(se),
          toPosition(se),
          toPosition(ne),
          toPosition(nw),
          toPosition(nw),
          toPosition(sw),
        ],
      ],
    },
    properties: {},
  }
}

/**
 * `n` parcels in a grid, sharing every interior edge exactly. For perf tests —
 * "does the snap index still answer in under a millisecond at 10 000 parcels?" —
 * and for the spatial index.
 *
 * Interior corners are shared exactly, because neighbouring cells are built from
 * the same metric offsets: a perf fixture whose parcels almost-but-not-quite touch
 * would quietly make the topology index do more work than production would.
 */
export function gridOfParcels(n: number, options: ParcelOptions = {}): readonly FeatureInput[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`[blaeu] gridOfParcels(n) needs a non-negative integer, got ${n}.`)
  }

  const origin = options.origin ?? ANKARA
  const width = options.widthMetres ?? PARCEL_WIDTH_M
  const height = options.heightMetres ?? PARCEL_HEIGHT_M
  const columns = Math.max(Math.ceil(Math.sqrt(n)), 1)

  const parcels: FeatureInput[] = []
  for (let i = 0; i < n; i++) {
    const col = i % columns
    const row = Math.floor(i / columns)
    const cellOrigin = offsetMetres(origin, col * width, row * height)
    parcels.push({
      id: `parcel-${i}`,
      geometry: { type: 'Polygon', coordinates: [rectangleRing(cellOrigin, width, height)] },
      properties: { ada: String(1000 + row), parsel: String(col) },
    })
  }
  return parcels
}

/* ========================================================================= */
/* Ring construction                                                         */
/* ========================================================================= */

/** A closed, counter-clockwise rectangle: SW → SE → NE → NW → SW. */
function rectangleRing(origin: LngLat, widthMetres: number, heightMetres: number): Position[] {
  return [
    toPosition(origin),
    toPosition(offsetMetres(origin, widthMetres, 0)),
    toPosition(offsetMetres(origin, widthMetres, heightMetres)),
    toPosition(offsetMetres(origin, 0, heightMetres)),
    // Closing coordinate: equal to the first, and a separate array — never the same
    // one, or an in-place edit of the first vertex would silently move the last.
    toPosition(origin),
  ]
}

function toPosition(lngLat: LngLat): Position {
  return [lngLat[0], lngLat[1]]
}
