import type {
  CollectionId,
  Geometry,
  LngLat,
  Severity,
  ValidationContext,
  ValidationIssue,
  ValidationRule,
} from '@blaeu/core'
import {
  closedRings,
  minParcelArea,
  noDuplicateVertices,
  noGapsWithNeighbours,
  noOverlapWithNeighbours,
  noSelfIntersection,
  noSlivers,
} from '@blaeu/plugin-topology'

import type { ResolvedCadastreOptions } from './options.js'
import { parcelAttributesRule } from './schema.js'

/**
 * Narrow a rule to one collection, keeping its id and severity.
 *
 * This is not a nicety, it is the difference between a usable issue list and an
 * unusable one. `noOverlapWithNeighbours` is domain-agnostic: it will happily
 * report that a building overlaps the parcel it stands on — which is *true*, and
 * which is also what buildings do. Unfiltered, a village of 400 houses produces 400
 * errors on day one, the surveyor learns to ignore the panel, and the one real
 * overlap in the dataset is lost in it.
 *
 * The relational rules are therefore parcel-to-parcel. The structural ones
 * (closed rings, duplicate vertices, self-intersection) are left unrestricted:
 * a bow-tie is a bow-tie whatever it is a bow-tie of.
 */
export const OUT_OF_BELT_RULE_ID = 'cadastre.crs.outOfBelt'

/**
 * Warn when a parcel is drawn outside the working CRS's belt.
 *
 * Turkey's cadastre uses 3°-wide TM belts; a parcel measured in the wrong one has a
 * projected area distorted by metres — enough to move a boundary in a dispute — while
 * looking perfectly fine on screen. This is the belt-mismatch guard the CRS `bounds`
 * field exists for (`ctx.crs.withinBounds`), finally wired up. It is a **warning**, never
 * an error: a dataset that legitimately spans two belts must still be storable, and the
 * fix is to switch the working CRS, not to reject the parcel. The message names the belt
 * the parcel actually belongs in, so the surveyor knows which one to switch to.
 */
export function outOfBeltRule(
  options: { readonly severity?: Severity; readonly collection?: CollectionId } = {},
): ValidationRule {
  const severity: Severity = options.severity ?? 'warning'
  const collection = options.collection

  return {
    id: OUT_OF_BELT_RULE_ID,
    severity,
    appliesTo: (feature) => collection === undefined || feature.meta.collection === collection,
    check(feature, ctx): readonly ValidationIssue[] {
      const at = firstPosition(feature.geometry)
      // No bounds on the working CRS, or the corner is inside the belt: nothing to say.
      if (at === undefined || ctx.crs.withinBounds(at)) return []

      const belt = suggestBelt(ctx, at)
      return [
        {
          rule: OUT_OF_BELT_RULE_ID,
          severity,
          message: belt
            ? ctx.t('cadastre.crs.outOfBelt', { feature: feature.id, belt })
            : ctx.t('cadastre.crs.outOfBeltUnknown', { feature: feature.id }),
          feature: feature.id,
          at,
          ...(belt !== undefined ? { data: { belt } } : {}),
        },
      ]
    },
  }
}

/** Wider than any real TM/UTM belt (≤6°), so a global system counts as "not a belt". */
const MAX_BELT_LONGITUDE_SPAN = 12

/**
 * The registered *belt* whose declared bounds contain the point most tightly — the one it
 * actually belongs in. Two exclusions matter: the working CRS itself, and any **global**
 * system such as Web Mercator, whose bounds contain every point and which is explicitly not
 * survey-grade. Naming Web Mercator as the belt to switch to would be worse than saying
 * nothing — so when only a global CRS matches, this returns `undefined` and the caller
 * falls back to the generic "outside the working belt" message. Smallest bounds area wins
 * among the remaining true belts.
 */
function suggestBelt(ctx: ValidationContext, at: LngLat): string | undefined {
  const working = ctx.crs.working.code
  let best: { name: string; area: number } | undefined
  for (const code of ctx.crs.list()) {
    if (code === working) continue
    const crs = ctx.crs.get(code)
    if (!crs?.bounds || !ctx.crs.withinBounds(at, code)) continue
    const [w, s, e, n] = crs.bounds
    if (e - w >= MAX_BELT_LONGITUDE_SPAN) continue // a global CRS, not a belt to switch to
    const area = (e - w) * (n - s)
    if (best === undefined || area < best.area) best = { name: crs.name ?? code, area }
  }
  return best?.name
}

/** The first coordinate of a geometry, as a lng/lat — enough to place a per-feature belt warning. */
function firstPosition(geometry: Geometry): LngLat | undefined {
  switch (geometry.type) {
    case 'Point':
      return asLngLat(geometry.coordinates)
    case 'MultiPoint':
    case 'LineString':
      return asLngLat(geometry.coordinates[0])
    case 'MultiLineString':
    case 'Polygon':
      return asLngLat(geometry.coordinates[0]?.[0])
    case 'MultiPolygon':
      return asLngLat(geometry.coordinates[0]?.[0]?.[0])
    case 'GeometryCollection':
      for (const child of geometry.geometries) {
        const found = firstPosition(child)
        if (found !== undefined) return found
      }
      return undefined
  }
}

function asLngLat(position: readonly number[] | undefined): LngLat | undefined {
  const lng = position?.[0]
  const lat = position?.[1]
  return lng !== undefined && lat !== undefined ? [lng, lat] : undefined
}

export function inCollection(rule: ValidationRule, collection: CollectionId): ValidationRule {
  return {
    id: rule.id,
    severity: rule.severity,
    appliesTo: (feature) =>
      feature.meta.collection === collection && (rule.appliesTo?.(feature) ?? true),
    check: (feature, ctx) => rule.check(feature, ctx),
  }
}

/**
 * The severities are the preset's entire contribution here — the topology plugin
 * knows *how* to find an overlap, and has no opinion about what one means.
 *
 * The asymmetry between an overlap and a gap is the sharpest domain judgement in
 * this package, and it is not a matter of taste:
 *
 * - **An overlap is a dispute.** Two parcels claiming the same square metre is a
 *   claim about who owns it, and the software must not be the thing that quietly
 *   files it. It blocks the write. The two owners, or a court, settle it.
 *
 * - **A gap is usually a digitisation artefact.** A 0.3 m² void between two
 *   boundaries almost always means somebody's mouse missed a corner by 4 cm, not
 *   that a strip of unowned land exists. It is worth reporting loudly and worth
 *   fixing — but blocking the save would mean the surveyor cannot store parcel A
 *   until they have drawn parcel B, and cannot store B without A. That is a
 *   deadlock built out of good intentions.
 *
 * `strictTopology: true` collapses the distinction, which is right at a submission
 * boundary where the dataset is supposed to already be clean.
 */
export function cadastreValidation(options: ResolvedCadastreOptions): readonly ValidationRule[] {
  const advisory: Severity = options.strictTopology ? 'error' : 'warning'
  const parcels = options.parcels

  const rules: ValidationRule[] = [
    // Structural, and cheap. They run first because every JSTS answer downstream of
    // an unclosed ring is either a crash or a lie.
    closedRings({ severity: 'error' }),
    noDuplicateVertices({ severity: 'error', tolerance: options.tolerance }),
    noSelfIntersection({ severity: 'error' }),

    inCollection(
      noOverlapWithNeighbours({ severity: 'error', tolerance: options.tolerance }),
      parcels,
    ),
    inCollection(
      noGapsWithNeighbours({
        severity: advisory,
        tolerance: options.tolerance,
        maxGapArea: options.maxGapArea,
      }),
      parcels,
    ),
    inCollection(minParcelArea({ severity: advisory, minArea: options.minParcelArea }), parcels),
    inCollection(noSlivers({ severity: advisory, sliverRatio: options.sliverRatio }), parcels),

    // A parcel drawn in the wrong TM belt: always advisory, never blocking (a cross-belt
    // dataset must stay storable), and it names the belt to switch the working CRS to.
    outOfBeltRule({ severity: 'warning', collection: parcels }),
  ]

  if (options.attributeSeverity !== 'off') {
    rules.push(
      parcelAttributesRule(options.parcelSchema, {
        severity: options.attributeSeverity,
        collection: parcels,
      }),
    )
  }

  return rules
}
