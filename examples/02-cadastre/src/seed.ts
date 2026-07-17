/**
 * The starting data — written the way a surveyor would actually hand it to you.
 *
 * Not as lng/lat. As a **koordinat özet cetveli**: a list of corner points in the
 * working projection, TUREF/TM30 (EPSG:5254), in metres. That is not decoration; it
 * is the reason the shared boundaries in this example are genuinely shared.
 *
 * Two adjacent parcels share a corner only if their two vertices land on the *same*
 * quantised coordinate (see `TopologyIndex` — it keys vertices by a 1 mm grid). Type
 * the same corner twice as decimal degrees and you will get two coordinates a
 * micro-degree apart, which is ~0.1 mm — usually fine, occasionally not, and always
 * a coin flip. Name the corner **once**, in metres, and inverse-project it: both
 * parcels then reference one point by construction, and the topology index has no
 * decision to make.
 *
 * ```
 *      x=0        x=42       x=88          (metres, east of the origin)
 * y=96  +----------+----------+
 *       |                     |
 *       |     102 / 9         |            ← 3.872 m²
 * y=52  +----------●----------+            ← ● is shared by ALL THREE parcels
 *       |          |          |
 *       | 102 / 7  | 102 / 8  |            ← 2.184 m²   2.392 m²
 * y=0   +----------+----------+
 * ```
 *
 * The middle node ● is the money shot: drag it and three parcels change at once,
 * in one command, undone by one Ctrl+Z.
 */

import {
  geometryBbox,
  type Bbox,
  type CrsService,
  type Polygon,
  type ProjectedXY,
} from '@blaeu/core'

/**
 * Origin of the local schedule, in TUREF/TM30 metres: a block near Sivrihisar,
 * Eskişehir. Inside the 30°E belt, which is what makes EPSG:5254 the right CRS here —
 * a parcel measured 6° from its central meridian is not slightly off, it is off by
 * metres. Working in the wrong belt is the single most expensive mistake available.
 */
const ORIGIN: ProjectedXY = [544_000, 4_392_000]

/** A corner, named once, in metres east/north of {@link ORIGIN}. */
type Corner = readonly [east: number, north: number]

/**
 * The corner list. Every parcel below refers to these by name, so a shared corner is
 * shared *in the source*, not by coincidence of rounding.
 */
const N = {
  sw: [0, 0],
  s: [42, 0],
  se: [88, 0],
  e: [88, 52],
  /** The three-way node. 102/7, 102/8 and 102/9 all carry a vertex here. */
  centre: [42, 52],
  w: [0, 52],
  ne: [88, 96],
  nw: [0, 96],
} as const satisfies Record<string, Corner>

export interface ParcelSeed {
  readonly id: string
  readonly ring: readonly Corner[]
  readonly properties: Record<string, string>
}

/**
 * Ada 102, parsels 7–9.
 *
 * `yuzolcumu` is conspicuously absent from every record. It is **derived** — the
 * commit pipeline stamps it from the geometry on the way into the store — and a seed
 * file that typed it would be asserting an area the corners might not agree with.
 * Which is the whole thing this preset exists to prevent.
 */
export const PARCEL_SEEDS: readonly ParcelSeed[] = [
  {
    id: 'ada102-parsel7',
    ring: [N.sw, N.s, N.centre, N.w],
    properties: {
      ada: '102',
      parsel: '7',
      pafta: 'G24-b-12-c',
      malik: 'Ayşe Kılıç',
      nitelik: 'Tarla',
      mevkii: 'Kaymaz',
    },
  },
  {
    id: 'ada102-parsel8',
    ring: [N.s, N.se, N.e, N.centre],
    properties: {
      ada: '102',
      parsel: '8',
      pafta: 'G24-b-12-c',
      malik: 'Mehmet Öztürk',
      nitelik: 'Bahçe',
      mevkii: 'Kaymaz',
    },
  },
  {
    // Note the vertex at `centre`: geometrically redundant (it sits on a straight
    // edge), topologically essential. Without it, 102/9 has no corner where its
    // neighbours have one, dragging the node would tear a gap open between them, and
    // the gap would be a strip of land with no owner. Real cadastral data has no
    // hanging nodes, and this is why.
    id: 'ada102-parsel9',
    ring: [N.w, N.centre, N.e, N.ne, N.nw],
    properties: {
      ada: '102',
      parsel: '9',
      pafta: 'G24-b-12-c',
      malik: 'Hazine',
      nitelik: 'Arsa',
      mevkii: 'Kaymaz',
    },
  },
]

/** Context, not the work: a traced roof inside 102/8. The preset makes it unselectable. */
export const BUILDING_SEEDS: readonly ParcelSeed[] = [
  {
    id: 'yapi-1',
    ring: [
      [52, 10],
      [78, 10],
      [78, 34],
      [52, 34],
    ],
    properties: { nitelik: 'Betonarme yapı', kat: '2' },
  },
]

/**
 * A bow-tie: the ring crosses itself. `topology.selfIntersection`, severity `error`.
 * The commit pipeline refuses it, so it never reaches the store even for a frame.
 */
export const SELF_INTERSECTING_RING: readonly Corner[] = [
  [0, -46],
  [42, -46],
  [0, -88],
  [42, -88],
]

/** Sits on top of 102/7 and 102/8. `topology.overlap`, severity `error` — an overlap is a dispute. */
export const OVERLAPPING_RING: readonly Corner[] = [
  [10, 10],
  [60, 10],
  [60, 40],
  [10, 40],
]

/**
 * The projection sandwich, run backwards: metres → lng/lat.
 *
 * The store is WGS84 and only WGS84 (core invariant 3), so this is where the
 * schedule crosses into it. Note that nothing downstream ever converts *back* by
 * hand — `map.crs.area()` and friends do the round trip themselves.
 */
export function ringToPolygon(crs: CrsService, ring: readonly Corner[]): Polygon {
  const plane = crs.working
  const coordinates = ring.map((corner) => {
    const xy: ProjectedXY = [ORIGIN[0] + corner[0], ORIGIN[1] + corner[1]]
    const [lng, lat] = plane.inverse(xy)
    return [lng, lat]
  })
  // GeoJSON closes its rings. The store would normalise this for us; saying it out
  // loud costs one line and means the geometry we hand over is already legal.
  const first = coordinates[0]
  if (first !== undefined) coordinates.push([...first])
  return { type: 'Polygon', coordinates: [coordinates] }
}

/** Where to point the camera before anything has been drawn. */
export function seedCentre(crs: CrsService): readonly [number, number] {
  return crs.working.inverse([ORIGIN[0] + 44, ORIGIN[1] + 48])
}

/** The extent of the block, so the map can frame the work rather than the planet. */
export function seedBounds(crs: CrsService): Bbox {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity

  for (const seed of [...PARCEL_SEEDS, ...BUILDING_SEEDS]) {
    const [w, s, e, n] = geometryBbox(ringToPolygon(crs, seed.ring))
    west = Math.min(west, w)
    south = Math.min(south, s)
    east = Math.max(east, e)
    north = Math.max(north, n)
  }

  return [west, south, east, north]
}
