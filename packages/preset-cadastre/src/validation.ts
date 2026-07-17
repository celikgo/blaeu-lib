import type { CollectionId, Severity, ValidationRule } from '@blaeu/core'
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
