import {
  distanceToSegment,
  distanceXY,
  toLngLat,
  type Bbox,
  type CrsService,
  type EdgeRef,
  type FeatureId,
  type FeatureStore,
  type BlaeuFeature,
  type Geometry,
  type I18n,
  type LngLat,
  type Position,
  type ProjectedCrs,
  type ProjectedXY,
  type ScreenPoint,
  type SnapCandidate,
  type SnapKind,
  type SnapQueryContext,
} from '@blaeu/core'
import { INDICATOR_SOURCE, PRIORITY, SEARCH_SLACK } from './constants.js'

/**
 * The planar maths every built-in provider shares.
 *
 * All of it happens in the **working CRS, in metres** (core invariant 3). A
 * perpendicular foot computed on lng/lat is wrong by the cosine of the latitude —
 * at Ankara it lands about 30 cm off a 50 m edge, which renders perfectly and is
 * a boundary dispute.
 */

/** What a provider is built with. Set once, at plugin setup. */
export interface SnapDeps {
  readonly store: FeatureStore
  readonly crs: CrsService
  readonly i18n: I18n
  /** Shared across providers and reset once per pointer event. */
  readonly cache: FrameCache
  /** Metres in the working CRS. Only the grid provider reads it. */
  readonly gridSize: number
}

/** One projected path of a geometry: a line, or one ring of a polygon. */
export interface ProjectedPath {
  readonly part: number
  readonly ring: number
  /** Ring paths keep their closing coordinate, so the closing edge is a segment like any other. */
  readonly xy: readonly ProjectedXY[]
}

/** A projected segment, addressed the way {@link EdgeRef} does. */
export interface Segment {
  readonly edge: EdgeRef
  readonly a: ProjectedXY
  readonly b: ProjectedXY
}

/**
 * Per-event memo.
 *
 * Five providers run on every pointer move and all of them want the same handful
 * of features projected into the same plane. Projecting a 400-vertex parcel five
 * times, 120 times a second, is 240 000 proj4 calls a second for one parcel — so
 * the engine resets this cache once per event and the providers share the work.
 *
 * It is deliberately not longer-lived than one event: a store write or a
 * `crs.setWorking()` between two pointer moves would silently invalidate it, and a
 * stale projection is a vertex in the wrong place.
 */
export class FrameCache {
  readonly #paths = new Map<FeatureId, readonly ProjectedPath[]>()
  readonly #features = new Map<string, readonly BlaeuFeature[]>()

  reset(): void {
    this.#paths.clear()
    this.#features.clear()
  }

  /**
   * Snappable features whose bbox meets `bbox`, from every collection.
   *
   * Excluded: the feature(s) the caller is currently dragging or drawing (they must
   * not snap to themselves), hidden features (you cannot aim at what you cannot
   * see), and the indicator's own overlay source — which sits *exactly* under the
   * cursor whenever a snap is live, and would otherwise snap the pointer to the
   * mark that the pointer just produced.
   */
  features(
    store: FeatureStore,
    bbox: Bbox,
    exclude: ReadonlySet<FeatureId>,
  ): readonly BlaeuFeature[] {
    const key = bbox.join(',')
    const hit = this.#features.get(key)
    if (hit !== undefined) return hit

    const out: BlaeuFeature[] = []
    for (const collection of store.collections()) {
      if (collection === INDICATOR_SOURCE) continue
      for (const feature of store.collection(collection).query(bbox)) {
        if (exclude.has(feature.id)) continue
        if (feature.meta.hidden === true) continue
        // UI scaffolding: a vertex handle, a transform box. Drawn, but not geometry.
        // A handle sits exactly on the vertex it represents, so without this the pointer
        // snaps onto the handle of the very vertex being dragged and the vertex is pinned
        // in place — every drag shorter than the tolerance becomes a silent no-op. The
        // flag lives on the feature rather than in a list of collection names here,
        // because this plugin has never heard of the edit plugin and must not start now.
        if (feature.meta.snappable === false) continue
        out.push(feature)
      }
    }
    this.#features.set(key, out)
    return out
  }

  paths(feature: BlaeuFeature, plane: ProjectedCrs): readonly ProjectedPath[] {
    const hit = this.#paths.get(feature.id)
    if (hit !== undefined) return hit

    const out: ProjectedPath[] = []
    eachPath(feature.geometry, (part, ring, positions) => {
      out.push({
        part,
        ring,
        xy: positions.map((position) => plane.forward(toLngLat(position))),
      })
    })
    this.#paths.set(feature.id, out)
    return out
  }
}

/**
 * Every path of a geometry, addressed as {@link EdgeRef} addresses it.
 *
 * `GeometryCollection` is skipped for the same reason core's `eachVertex` skips it:
 * `VertexRef`/`EdgeRef` cannot express "member 2 of the collection", and inventing
 * an addressing scheme here would leak one that nothing else in the library shares.
 */
export function eachPath(
  geometry: Geometry,
  visit: (part: number, ring: number, positions: readonly Position[]) => void,
): void {
  switch (geometry.type) {
    case 'Point':
    case 'MultiPoint':
      return
    case 'LineString':
      visit(0, 0, geometry.coordinates)
      return
    case 'MultiLineString':
      geometry.coordinates.forEach((line, part) => visit(part, 0, line))
      return
    case 'Polygon':
      geometry.coordinates.forEach((ring, index) => visit(0, index, ring))
      return
    case 'MultiPolygon':
      geometry.coordinates.forEach((polygon, part) =>
        polygon.forEach((ring, index) => visit(part, index, ring)),
      )
      return
    case 'GeometryCollection':
      return
  }
}

/* ========================================================================= */
/* The per-query scope                                                       */
/* ========================================================================= */

/**
 * Everything a provider needs to turn "near the pointer" into a number, built once
 * per `query()` call.
 *
 * The two units live side by side on purpose. *Closeness* is a screen-pixel fact —
 * ten pixels means the same thing to a user at every zoom. *Geometry* is a metric
 * fact and must happen in the plane. The scope owns the conversion between them so
 * that no provider has to reinvent it, and gets it subtly wrong.
 */
export interface SnapScope {
  readonly deps: SnapDeps
  readonly query: SnapQueryContext
  readonly plane: ProjectedCrs
  /** The *raw* pointer, before any middleware rewrote it. */
  readonly cursor: ScreenPoint
  readonly cursorXY: ProjectedXY
  readonly tolerancePx: number
  readonly metresPerPixel: number
  /** The tolerance circle, in the plane. */
  readonly toleranceMetres: number
  /** The pre-filter radius: the tolerance, plus slack for projection distortion. */
  readonly searchMetres: number

  /** Screen-pixel distance from the raw pointer to a geographic point. The definition of "close". */
  distancePx(point: LngLat): number
  toLngLat(xy: ProjectedXY): LngLat
}

/** Baseline for the pixel↔metre scale. Wide enough that float noise in `unproject` does not dominate. */
const PROBE_PX = 16

export function createScope(
  deps: SnapDeps,
  point: LngLat,
  tolerancePx: number,
  query: SnapQueryContext,
): SnapScope {
  const plane = deps.crs.working
  const cursor = query.project(point)
  const cursorXY = plane.forward(point)

  // The local scale of the projection at the cursor, measured rather than assumed.
  // A hard-coded degrees-per-pixel would be wrong by cos(latitude) and wrong again
  // in a projection whose scale factor is not 1 — which is every projection a
  // surveyor uses.
  const probe = plane.forward(query.unproject({ x: cursor.x + PROBE_PX, y: cursor.y }))
  const metresPerPixel = distanceXY(cursorXY, probe) / PROBE_PX

  const toleranceMetres = tolerancePx * metresPerPixel

  return {
    deps,
    query,
    plane,
    cursor,
    cursorXY,
    tolerancePx,
    metresPerPixel,
    toleranceMetres,
    searchMetres: toleranceMetres * SEARCH_SLACK,
    distancePx: (candidate) => screenDistance(cursor, query.project(candidate)),
    toLngLat: (xy) => plane.inverse(xy),
  }
}

export function screenDistance(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/* ========================================================================= */
/* Candidates                                                                */
/* ========================================================================= */

/** The optional half of a {@link SnapCandidate}. Absent, never `undefined` — `exactOptionalPropertyTypes`. */
export type CandidateRefs = Partial<Pick<SnapCandidate, 'feature' | 'vertex' | 'edge' | 'hint'>>

/**
 * A candidate at a point already known in the plane.
 *
 * Returns `undefined` — rather than a candidate the engine would then discard —
 * when the point falls outside the tolerance *in pixels*, which is the only
 * measurement of "close" that matches what the user sees.
 */
export function candidateAt(
  scope: SnapScope,
  kind: SnapKind,
  xy: ProjectedXY,
  refs: CandidateRefs = {},
): SnapCandidate | undefined {
  return candidateAtLngLat(scope, kind, scope.toLngLat(xy), refs)
}

/**
 * A candidate at a point already known in 4326.
 *
 * Used for vertices, whose coordinate must come back **verbatim** from the store
 * rather than through `inverse(forward(p))`. The round trip is accurate to
 * nanometres, and nanometres are exactly the problem: two parcels sharing a corner
 * hold that corner as the same bits, the topology index keys on it, and a snap that
 * returned a value one ULP away would place the new vertex *next to* the shared
 * corner instead of *on* it — which is how a sliver is born.
 */
export function candidateAtLngLat(
  scope: SnapScope,
  kind: SnapKind,
  point: LngLat,
  refs: CandidateRefs = {},
): SnapCandidate | undefined {
  const distancePx = scope.distancePx(point)
  if (!(distancePx <= scope.tolerancePx)) return undefined

  const priority = PRIORITY[kind] ?? 0
  return { kind, point, distancePx, priority, ...refs }
}

/** Localised label for the snap indicator's tooltip. Falls back to the key, as `I18n.t` does. */
export function hint(deps: SnapDeps, kind: SnapKind): string {
  return deps.i18n.t(`snap.${kind}`)
}

/* ========================================================================= */
/* Segments                                                                  */
/* ========================================================================= */

/**
 * Segments of `features` whose *body* passes within `radiusMetres` of the cursor.
 *
 * The radius filter is what keeps this off the O(n) path: a 400-vertex parcel whose
 * bbox meets the tolerance circle contributes, typically, two segments — not four
 * hundred.
 */
export function segmentsNear(
  scope: SnapScope,
  features: readonly BlaeuFeature[],
  radiusMetres: number,
): Segment[] {
  const out: Segment[] = []

  for (const feature of features) {
    for (const path of scope.deps.cache.paths(feature, scope.plane)) {
      for (let i = 0; i + 1 < path.xy.length; i++) {
        const a = path.xy[i]!
        const b = path.xy[i + 1]!
        if (distanceToSegment(scope.cursorXY, a, b) > radiusMetres) continue
        out.push({
          edge: { feature: feature.id, part: path.part, ring: path.ring, index: i },
          a,
          b,
        })
      }
    }
  }
  return out
}

/**
 * Segments whose *infinite line* passes within `radiusMetres` of the cursor, and
 * which are themselves no further away than `searchRadiusMetres`.
 *
 * This is what the extension and perpendicular providers need, and it is a
 * different question from {@link segmentsNear}: the edge may be nowhere near the
 * pointer — that is the entire point of an extension snap — while the line it lies
 * on passes right under it.
 */
export function segmentsWhoseLineIsNear(
  scope: SnapScope,
  features: readonly BlaeuFeature[],
  radiusMetres: number,
  searchRadiusMetres: number,
): Segment[] {
  const out: Segment[] = []

  for (const feature of features) {
    for (const path of scope.deps.cache.paths(feature, scope.plane)) {
      for (let i = 0; i + 1 < path.xy.length; i++) {
        const a = path.xy[i]!
        const b = path.xy[i + 1]!
        // A segment on the other side of the city lies on a line that may still pass
        // under the cursor; snapping to its continuation would be baffling. Bound the
        // search by the distance to the segment itself.
        if (distanceToSegment(scope.cursorXY, a, b) > searchRadiusMetres) continue
        const foot = footOnLine(scope.cursorXY, a, b)
        if (foot === undefined) continue
        if (distanceXY(scope.cursorXY, foot.xy) > radiusMetres) continue
        out.push({
          edge: { feature: feature.id, part: path.part, ring: path.ring, index: i },
          a,
          b,
        })
      }
    }
  }
  return out
}

export interface Foot {
  readonly xy: ProjectedXY
  /** Parameter along a→b. `0..1` is on the segment; outside it is on the extension. */
  readonly t: number
}

/** Foot of the perpendicular from `p` to the **infinite line** through `a` and `b`. */
export function footOnLine(p: ProjectedXY, a: ProjectedXY, b: ProjectedXY): Foot | undefined {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSq = dx * dx + dy * dy
  // A zero-length segment has no line. Real data contains them (a duplicate vertex
  // that survived an import), and dividing by their length yields NaN coordinates —
  // which render as nothing at all, and are the hardest bug in this library to trace.
  if (lengthSq === 0) return undefined

  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq
  return { xy: [a[0] + t * dx, a[1] + t * dy], t }
}

/** As {@link footOnLine}, but clamped to the segment — the nearest point *on the edge*. */
export function footOnSegment(p: ProjectedXY, a: ProjectedXY, b: ProjectedXY): Foot | undefined {
  const foot = footOnLine(p, a, b)
  if (foot === undefined) return undefined
  if (foot.t >= 0 && foot.t <= 1) return foot

  const t = foot.t < 0 ? 0 : 1
  return { xy: t === 0 ? a : b, t }
}

/**
 * Where two segments properly cross, in the plane.
 *
 * Only a *proper* crossing counts: both parameters strictly inside `(0, 1)`. Two
 * edges that merely touch at a shared corner are not an intersection — they are a
 * vertex, the vertex provider already offers it at priority 100, and emitting it
 * here as well would put a duplicate in `alternatives` for every shared corner in
 * the dataset.
 *
 * Collinear overlap returns `undefined` for the same reason: the "intersection" of
 * two overlapping collinear edges is a segment, not a point, and there is no
 * defensible point to snap to.
 */
export function segmentIntersection(
  a1: ProjectedXY,
  a2: ProjectedXY,
  b1: ProjectedXY,
  b2: ProjectedXY,
): ProjectedXY | undefined {
  const ax = a2[0] - a1[0]
  const ay = a2[1] - a1[1]
  const bx = b2[0] - b1[0]
  const by = b2[1] - b1[1]

  const denominator = ax * by - ay * bx
  if (denominator === 0) return undefined

  const dx = b1[0] - a1[0]
  const dy = b1[1] - a1[1]

  const t = (dx * by - dy * bx) / denominator
  const u = (dx * ay - dy * ax) / denominator
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return undefined

  return [a1[0] + t * ax, a1[1] + t * ay]
}

/** Stable dedupe key for a coordinate: the working CRS's precision grid, and nothing finer. */
export function pointKey(scope: SnapScope, point: LngLat): string {
  const [lng, lat] = scope.deps.crs.quantise(point)
  return `${lng},${lat}`
}
