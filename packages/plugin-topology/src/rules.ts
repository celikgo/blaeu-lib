/**
 * The topology rules.
 *
 * Each one is a factory returning a `ValidationRule`, and each is exported
 * individually — because a rule is where the *domain* lives, and only the domain
 * knows the severity. The topology plugin knows how to find an overlap; only the
 * cadastre preset knows that an overlap is an error and a gap is a warning. So a
 * preset composes these:
 *
 * ```ts
 * validation: [
 *   noSelfIntersection(),
 *   noOverlapWithNeighbours({ severity: 'error' }),
 *   noGapsWithNeighbours({ severity: 'warning', maxGapArea: 0.5 }),
 *   minParcelArea({ minArea: 25 }),
 * ]
 * ```
 *
 * Everything here that touches geometry does so in the **projected working CRS, in
 * metres** (core invariant 3). Nothing computes an area, a length or a tolerance in
 * degrees, ever.
 */

import {
  bboxAround,
  geometryBbox,
  isRingClosed,
  planarDistance,
  type Bbox,
  type FlexiFeature,
  type Geometry,
  type LngLat,
  type Position,
  type ProjectedCrs,
  type ProjectedXY,
  type Severity,
  type ValidationContext,
  type ValidationIssue,
  type ValidationRule,
} from '@fleximap/core'

import {
  buffer,
  centroid,
  components,
  convexHull,
  difference,
  intersection,
  projectGeometry,
  read,
  reduce,
  touchesOrIntersects,
  toLngLat,
  union,
  validityError,
  type JstsGeometry,
} from './jsts.js'

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

/**
 * 1 mm. The cadastral grid: below this, two coordinates are the same corner, and
 * pretending otherwise is how a boolean op invents a sliver.
 */
export const DEFAULT_TOLERANCE_METRES = 0.001

/**
 * Perimeter² / area. A square scores 16, a circle 12.57 — the ratio is
 * dimensionless, so it does not care whether a parcel is 20 m² or 20 000 m², only
 * whether it is *thin*. 100 is about a 1:20 strip, which is a plausible legal
 * parcel (a right-of-way) and an implausible digitised boundary, so it is a
 * warning rather than an error.
 */
export const DEFAULT_SLIVER_RATIO = 100

/** A gap larger than this is a feature of the world — a road, a stream — not a digitisation artefact. */
export const DEFAULT_MAX_GAP_AREA_M2 = 1

/**
 * Metres. Half the widest void this rule will call an artefact: 25 cm here means a
 * void up to 50 cm wide is a mis-digitised edge, and anything wider is a lane.
 *
 * It also bounds the cost — the search is a buffer intersection, so nothing is ever
 * compared against a parcel further away than this.
 */
export const DEFAULT_MAX_GAP_WIDTH_METRES = 0.25

/** How far to look for a neighbour that a gap might sit against, in metres. */
export const DEFAULT_GAP_SEARCH_METRES = 1

/** A placeholder minimum. Every real cadastre has a legal one; the preset supplies it. */
export const DEFAULT_MIN_AREA_M2 = 1

/** Rule ids are namespaced, so `validate()` can find its own rules in a registry full of a preset's. */
export const TOPOLOGY_RULE_PREFIX = 'topology.'

export const RULE_IDS = {
  selfIntersection: 'topology.self-intersection',
  overlap: 'topology.overlap',
  gap: 'topology.gap',
  minArea: 'topology.min-area',
  closedRings: 'topology.closed-rings',
  duplicateVertices: 'topology.duplicate-vertices',
  slivers: 'topology.slivers',
} as const

/**
 * The two rules that cost nothing: no projection, no JSTS, no neighbour query.
 *
 * `ValidationRule` has no priority field, so "run these first" cannot be declared —
 * it has to be arranged. `TopologyApi.validate()` runs these before the expensive
 * ones and skips the JSTS work for any feature they reject, because feeding a ring
 * with a duplicate vertex to an overlay operation produces either a crash or a lie,
 * and the crash's stack trace points at the wrong code entirely.
 */
export const STRUCTURAL_RULE_IDS: ReadonlySet<string> = new Set([
  RULE_IDS.closedRings,
  RULE_IDS.duplicateVertices,
])

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

export interface RuleOptions {
  readonly severity?: Severity
}

export interface ToleranceRuleOptions extends RuleOptions {
  /** Metres. Default 1 mm — the cadastral grid, not a degree. */
  readonly tolerance?: number
}

export interface GapRuleOptions extends ToleranceRuleOptions {
  /** m². A gap smaller than this is an artefact worth reporting; larger is a road. */
  readonly maxGapArea?: number
  /** Metres. A void wider than twice this is a deliberate space, not a slip of the mouse. */
  readonly maxGapWidth?: number
  /** Metres. How far away a neighbour can be and still be worth comparing against. */
  readonly searchDistance?: number
}

export interface MinAreaRuleOptions extends RuleOptions {
  /** m², in the working CRS. */
  readonly minArea?: number
}

export interface SliverRuleOptions extends RuleOptions {
  /** perimeter² / area. Higher = thinner. See {@link DEFAULT_SLIVER_RATIO}. */
  readonly sliverRatio?: number
}

/* ------------------------------------------------------------------ *
 * The rules
 * ------------------------------------------------------------------ */

/**
 * The ring must not cross itself.
 *
 * `error` by default and not negotiable in any registry we know of: a
 * self-intersecting parcel has no defined area, so every downstream number
 * computed from it — including the one on the title deed — is arbitrary.
 *
 * The issue carries `at`, the coordinate JSTS names as the intersection point. An
 * error that says "invalid geometry" without saying *where* leaves a surveyor
 * scrolling through 400 vertices.
 */
export function noSelfIntersection(options: RuleOptions = {}): ValidationRule {
  return {
    id: RULE_IDS.selfIntersection,
    severity: options.severity ?? 'error',
    appliesTo: isPolygonal,
    check(feature, ctx) {
      const plane = ctx.crs.working
      // Deliberately *not* precision-reduced: GeometryPrecisionReducer can throw on a
      // self-intersecting polygon, and a validity check that crashes on invalid input
      // is not a validity check.
      const error = validityError(read(projectGeometry(feature.geometry, plane)))
      if (!error) return []

      // JSTS's own wording is English, and it is a *detail*, not the message — so the
      // sentence the surveyor reads is localised even though the detail is not.
      const selfIntersecting = error.message.toLowerCase().includes('self-intersection')
      const message = selfIntersecting
        ? ctx.t('topology.selfIntersection', { feature: feature.id })
        : ctx.t('topology.invalidGeometry', { feature: feature.id, detail: error.message })

      return [
        makeIssue({
          rule: RULE_IDS.selfIntersection,
          severity: this.severity,
          message,
          feature: feature.id,
          at: error.at ? plane.inverse(error.at) : undefined,
          data: { detail: error.message },
        }),
      ]
    },
  }
}

/**
 * No feature may overlap a neighbour.
 *
 * `error` by default: two title deeds claiming the same square metre is a dispute,
 * and a dispute must not be storable. The issue carries the overlap area, because
 * the first question anyone asks is "by how much?".
 */
export function noOverlapWithNeighbours(options: ToleranceRuleOptions = {}): ValidationRule {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_METRES
  // An overlap thinner than the precision grid is not an overlap, it is float noise:
  // a 1 mm sliver along a 100 m shared edge is 0.1 m², which would otherwise be
  // reported as a boundary dispute on every single shared edge in the layer.
  const minOverlapArea = tolerance * tolerance

  return {
    id: RULE_IDS.overlap,
    severity: options.severity ?? 'error',
    appliesTo: isPolygonal,
    check(feature, ctx) {
      const plane = ctx.crs.working
      const subject = prepare(feature.geometry, plane)
      if (!subject) return []

      const issues: ValidationIssue[] = []
      for (const neighbour of candidateNeighbours(feature, ctx, tolerance)) {
        const other = prepare(neighbour.geometry, plane)
        if (!other) continue

        const shared = intersection(subject, other)
        const area = shared.getArea()
        if (area <= minOverlapArea) continue

        issues.push(
          makeIssue({
            rule: RULE_IDS.overlap,
            severity: this.severity,
            message: ctx.t('topology.overlap', {
              feature: feature.id,
              neighbour: neighbour.id,
              area: area.toFixed(3),
            }),
            feature: feature.id,
            at: unproject(centroid(shared), plane),
            data: { overlapArea: area, neighbour: neighbour.id },
          }),
        )
      }
      return issues
    },
  }
}

/**
 * No slim gap between a feature and its neighbours.
 *
 * `warning` by default, and the asymmetry with overlap is a **domain judgement, not
 * an oversight**. An overlap means two people claim the same ground: someone is
 * wrong, and the registry must not store it. A gap usually means nobody digitised
 * the shared edge twice from the same corner — it is an artefact of the drawing,
 * not a claim about the world, and blocking the write would strand a surveyor who
 * has correctly recorded what the monuments say. Report it, let them decide.
 *
 * A preset in a jurisdiction where unclaimed land between parcels is legally
 * impossible should raise this to `error`. That is exactly why it is an option.
 */
export function noGapsWithNeighbours(options: GapRuleOptions = {}): ValidationRule {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_METRES
  const maxGapArea = options.maxGapArea ?? DEFAULT_MAX_GAP_AREA_M2
  const maxGapWidth = options.maxGapWidth ?? DEFAULT_MAX_GAP_WIDTH_METRES
  const searchDistance = options.searchDistance ?? DEFAULT_GAP_SEARCH_METRES
  const minOverlapArea = tolerance * tolerance

  return {
    id: RULE_IDS.gap,
    severity: options.severity ?? 'warning',
    appliesTo: isPolygonal,
    check(feature, ctx) {
      const plane = ctx.crs.working
      const subject = prepare(feature.geometry, plane)
      if (!subject) return []

      const issues: ValidationIssue[] = []
      for (const neighbour of candidateNeighbours(feature, ctx, searchDistance)) {
        const other = prepare(neighbour.geometry, plane)
        if (!other) continue

        const shared = intersection(subject, other)

        // An overlapping pair is the overlap rule's business. Reporting it here as
        // well would give the surveyor two issues for one problem, and the second
        // would be wrong.
        if (shared.getArea() > minOverlapArea) continue

        // They already share a real edge. Two parcels digitised from the same corners
        // have nothing between them by construction, and asking a boolean op whether
        // they do anyway is how you get told about a 0.03 m² "gap" that is only the
        // projected boundary being very slightly non-straight. Skip.
        if (!shared.isEmpty() && shared.getLength() > tolerance) continue

        // The void *between* the pair: the ground that is within `maxGapWidth` of both
        // and inside neither. Not a convex-hull difference — a hull manufactures voids
        // out of the pair's own concavity, which is not a gap between them at all, and
        // it does so on every L-shaped parcel in a real layer.
        const merged = union(subject, other)
        const between = intersection(buffer(subject, maxGapWidth), buffer(other, maxGapWidth))
        // Clipped to the hull, which trims the buffers' end caps — the round bulges that
        // stick out past the parcels' extent, and would otherwise be counted as gap area.
        const voids = difference(intersection(between, convexHull(merged)), merged)

        for (const gap of components(voids)) {
          const area = gap.getArea()
          if (area <= 0 || area >= maxGapArea) continue

          // A real gap sits against both parcels. A void touching only one of them is
          // the parcel's own concavity, and that is a shape, not a defect.
          if (!touchesOrIntersects(gap, subject) || !touchesOrIntersects(gap, other)) continue

          issues.push(
            makeIssue({
              rule: RULE_IDS.gap,
              severity: this.severity,
              message: ctx.t('topology.gap', {
                feature: feature.id,
                neighbour: neighbour.id,
                area: area.toFixed(3),
              }),
              feature: feature.id,
              at: unproject(centroid(gap), plane),
              data: { gapArea: area, neighbour: neighbour.id },
            }),
          )
        }
      }
      return issues
    },
  }
}

/**
 * A parcel must be at least `minArea` square metres.
 *
 * The area comes from `ctx.crs.area`, which is planar maths in the working CRS —
 * the number a land registry will accept. A spherical area on a 2 000 m² parcel at
 * 39°N is out by square metres, and square metres move boundaries.
 */
export function minParcelArea(options: MinAreaRuleOptions = {}): ValidationRule {
  const minArea = options.minArea ?? DEFAULT_MIN_AREA_M2

  return {
    id: RULE_IDS.minArea,
    severity: options.severity ?? 'error',
    appliesTo: isPolygonal,
    check(feature, ctx) {
      const area = ctx.crs.area(feature.geometry)
      if (area >= minArea) return []

      const plane = ctx.crs.working
      const subject = prepare(feature.geometry, plane)
      return [
        makeIssue({
          rule: RULE_IDS.minArea,
          severity: this.severity,
          message: ctx.t('topology.minArea', {
            feature: feature.id,
            area: area.toFixed(3),
            minimum: String(minArea),
          }),
          feature: feature.id,
          at: subject ? unproject(centroid(subject), plane) : undefined,
          data: { area, minArea },
        }),
      ]
    },
  }
}

/**
 * Every ring closes, and has at least three distinct corners.
 *
 * Structural, and cheap — no projection, no JSTS. Run it first: an unclosed ring
 * fed to an overlay operation fails somewhere deep inside JTS, and the stack trace
 * blames the boolean op rather than the import that produced the ring.
 */
export function closedRings(options: RuleOptions = {}): ValidationRule {
  return {
    id: RULE_IDS.closedRings,
    severity: options.severity ?? 'error',
    appliesTo: isPolygonal,
    check(feature, ctx) {
      const issues: ValidationIssue[] = []

      for (const ring of polygonRings(feature.geometry)) {
        const first = ring[0]
        if (first === undefined) continue

        if (!isRingClosed(ring)) {
          issues.push(
            makeIssue({
              rule: RULE_IDS.closedRings,
              severity: this.severity,
              message: ctx.t('topology.unclosedRing', { feature: feature.id }),
              feature: feature.id,
              at: toLngLat(first),
              data: { vertices: ring.length },
            }),
          )
          continue
        }

        // A closed ring needs four positions to describe a triangle. Three describes a
        // line drawn there and back, which has zero area and no interior.
        if (ring.length < 4) {
          issues.push(
            makeIssue({
              rule: RULE_IDS.closedRings,
              severity: this.severity,
              message: ctx.t('topology.shortRing', { feature: feature.id }),
              feature: feature.id,
              at: toLngLat(first),
              data: { vertices: ring.length },
            }),
          )
        }
      }
      return issues
    },
  }
}

/**
 * No two consecutive vertices within `tolerance` of each other.
 *
 * `warning`, because nobody ever *meant* a duplicate vertex — it is a defect in the
 * digitising, not a claim about the boundary, and it is one of the two things this
 * package can actually repair (see `fix`). Blocking a surveyor's write over
 * something we can silently offer to fix would be theatre.
 *
 * The comparison is a planar distance **in metres**. Comparing positions for float
 * equality would miss the 0.4 mm duplicate that a bad import produces, which is
 * exactly the one that later blows up a boolean op.
 */
export function noDuplicateVertices(options: ToleranceRuleOptions = {}): ValidationRule {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_METRES

  return {
    id: RULE_IDS.duplicateVertices,
    severity: options.severity ?? 'warning',
    appliesTo: isPolygonal,
    check(feature, ctx) {
      const plane = ctx.crs.working
      const duplicates: LngLat[] = []

      for (const ring of polygonRings(feature.geometry)) {
        // The closing coordinate legitimately repeats the first, so it is compared
        // against its *predecessor* like every other vertex — and against nothing else.
        for (let i = 1; i < ring.length; i++) {
          const previous = ring[i - 1]
          const current = ring[i]
          if (previous === undefined || current === undefined) continue

          const a = plane.forward(toLngLat(previous))
          const b = plane.forward(toLngLat(current))
          if (planarDistance(a, b) <= tolerance) duplicates.push(toLngLat(current))
        }
      }

      if (duplicates.length === 0) return []

      return [
        makeIssue({
          rule: RULE_IDS.duplicateVertices,
          severity: this.severity,
          message: ctx.t('topology.duplicateVertex', {
            feature: feature.id,
            count: String(duplicates.length),
            tolerance: String(tolerance),
          }),
          feature: feature.id,
          at: duplicates[0],
          data: { count: duplicates.length, tolerance },
        }),
      ]
    },
  }
}

/**
 * No thin slivers.
 *
 * `perimeter² / area` is dimensionless, so one threshold works for a garden and for
 * a farm: it measures thinness, not size. A square is 16; a 1:20 strip is about
 * 100. Both area and perimeter come from the working CRS, in metres.
 *
 * `warning`: a genuinely thin parcel exists (a right-of-way, a strip of frontage),
 * so this cannot be an error without rejecting real land.
 */
export function noSlivers(options: SliverRuleOptions = {}): ValidationRule {
  const limit = options.sliverRatio ?? DEFAULT_SLIVER_RATIO

  return {
    id: RULE_IDS.slivers,
    severity: options.severity ?? 'warning',
    appliesTo: isPolygonal,
    check(feature, ctx) {
      const issues: ValidationIssue[] = []
      const plane = ctx.crs.working

      // Per part, not per feature: a MultiPolygon of one fat parcel and one sliver
      // averages out to "fine", and the sliver is still there.
      for (const part of polygonParts(feature.geometry)) {
        const area = ctx.crs.area(part)
        if (area <= 0) continue

        const perimeter = ctx.crs.length(part)
        const ratio = (perimeter * perimeter) / area
        if (ratio <= limit) continue

        const subject = prepare(part, plane)
        issues.push(
          makeIssue({
            rule: RULE_IDS.slivers,
            severity: this.severity,
            message: ctx.t('topology.sliver', {
              feature: feature.id,
              ratio: ratio.toFixed(1),
              limit: String(limit),
            }),
            feature: feature.id,
            at: subject ? unproject(centroid(subject), plane) : undefined,
            data: { ratio, area, perimeter, limit },
          }),
        )
      }
      return issues
    },
  }
}

/* ------------------------------------------------------------------ *
 * Shared machinery
 * ------------------------------------------------------------------ */

export function isPolygonal(feature: FlexiFeature): boolean {
  return feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon'
}

/**
 * Projects, reads, and reduces to the CRS's precision grid — in that order.
 *
 * Returns `undefined` for a geometry JSTS cannot make sense of (an invalid ring,
 * say). The caller skips it rather than throwing: an invalid polygon is the
 * self-intersection rule's problem, and an overlay run on one either throws inside
 * JTS or — worse — returns a plausible number that is wrong.
 */
function prepare(geometry: Geometry, plane: ProjectedCrs): JstsGeometry | undefined {
  try {
    const projected = read(projectGeometry(geometry, plane))
    if (validityError(projected) !== undefined) return undefined
    return reduce(projected, plane.precision)
  } catch {
    return undefined
  }
}

/**
 * Candidate neighbours from the spatial index — never a full scan.
 *
 * At 10 000 parcels a full scan is 10 000 projections and 10 000 overlays per
 * feature validated, which is 100 million operations for a layer check. The index
 * answers in O(log n), and the handful it returns are the only ones whose bounding
 * boxes could possibly touch.
 */
function candidateNeighbours(
  feature: FlexiFeature,
  ctx: ValidationContext,
  radiusMetres: number,
): readonly FlexiFeature[] {
  const collection = ctx.store.collection(feature.meta.collection)
  const bbox = expandBbox(geometryBbox(feature.geometry), radiusMetres, ctx.crs)
  return collection.query(bbox).filter((f) => f.id !== feature.id && isPolygonal(f))
}

/**
 * Grows a bbox by a *metric* radius.
 *
 * The degree delta is derived by projecting, offsetting in metres, and
 * un-projecting — not by the usual `metres / 111320` fudge, which is wrong by the
 * cosine of the latitude and would quietly shrink the search box at Turkish
 * latitudes by a fifth.
 */
function expandBbox(bbox: Bbox, radiusMetres: number, crs: ValidationContext['crs']): Bbox {
  const [west, south, east, north] = bbox
  const centre: LngLat = [(west + east) / 2, (south + north) / 2]
  const [w, s, e, n] = bboxAround(crs, centre, radiusMetres)
  const dLng = (e - w) / 2
  const dLat = (n - s) / 2
  return [west - dLng, south - dLat, east + dLng, north + dLat]
}

/** Every ring of every polygon part, exterior and holes alike. */
export function polygonRings(geometry: Geometry): readonly Position[][] {
  switch (geometry.type) {
    case 'Polygon':
      return geometry.coordinates
    case 'MultiPolygon':
      return geometry.coordinates.flat()
    default:
      return []
  }
}

/** Each polygon part of a Polygon or MultiPolygon, as its own geometry. */
function polygonParts(geometry: Geometry): readonly Geometry[] {
  switch (geometry.type) {
    case 'Polygon':
      return [geometry]
    case 'MultiPolygon':
      return geometry.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }))
    default:
      return []
  }
}

function unproject(xy: ProjectedXY | undefined, plane: ProjectedCrs): LngLat | undefined {
  return xy === undefined ? undefined : plane.inverse(xy)
}

interface IssueInput {
  readonly rule: string
  readonly severity: Severity
  readonly message: string
  readonly feature: string
  readonly at: LngLat | undefined
  readonly data: Record<string, unknown>
}

/**
 * `exactOptionalPropertyTypes` means `{ at: undefined }` is not assignable to
 * `{ at?: LngLat }` — the key has to be *absent*, not present-and-undefined. Doing
 * that conditional spread once, here, keeps it out of every rule.
 */
function makeIssue(input: IssueInput): ValidationIssue {
  return {
    rule: input.rule,
    severity: input.severity,
    message: input.message,
    feature: input.feature,
    ...(input.at !== undefined ? { at: input.at } : {}),
    data: input.data,
  }
}
