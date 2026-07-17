import type { LngLat, SnapCandidate, SnapProvider, SnapQueryContext } from '@blaeu/core'
import { PRIORITY } from '../constants.js'
import {
  candidateAt,
  createScope,
  hint,
  pointKey,
  segmentIntersection,
  segmentsNear,
  type SnapDeps,
} from '../geometry.js'

/**
 * Snap to where two edges cross.
 *
 * A crossing is a *constructed* point: it exists in the data only implicitly, which
 * is exactly why it needs a provider. A road centreline over a parcel boundary, a
 * new easement over an old one — the point the surveyor wants is the one neither
 * geometry contains.
 *
 * Priority 90, below vertex: where a crossing coincides with a corner, the corner is
 * the real thing and the crossing is an artefact of it.
 *
 * The pairwise loop is quadratic in the number of segments *near the pointer*, which
 * the metric pre-filter keeps at a handful — two edges that cross within the
 * tolerance circle both necessarily pass through it. Quadratic on four segments is
 * six comparisons; the alternative (an index of pre-computed crossings, rebuilt on
 * every store write) costs more to maintain than it can ever save at 120 Hz.
 */
export function createIntersectionProvider(deps: SnapDeps): SnapProvider {
  return {
    id: 'intersection',
    priority: PRIORITY['intersection'] ?? 90,

    query(point: LngLat, tolerancePx: number, ctx: SnapQueryContext): readonly SnapCandidate[] {
      const scope = createScope(deps, point, tolerancePx, ctx)
      const features = deps.cache.features(deps.store, ctx.bbox, ctx.exclude)
      const segments = segmentsNear(scope, features, scope.searchMetres)

      const out: SnapCandidate[] = []
      const seen = new Set<string>()

      for (let i = 0; i < segments.length; i++) {
        const a = segments[i]!
        for (let j = i + 1; j < segments.length; j++) {
          const b = segments[j]!

          const xy = segmentIntersection(a.a, a.b, b.a, b.b)
          if (xy === undefined) continue

          // No `feature` ref: a crossing belongs to *two* features, and naming one of
          // them would tell a downstream editor a half-truth it would then act on.
          const candidate = candidateAt(scope, 'intersection', xy, {
            hint: hint(deps, 'intersection'),
          })
          if (candidate === undefined) continue

          const key = pointKey(scope, candidate.point)
          if (seen.has(key)) continue
          seen.add(key)
          out.push(candidate)
        }
      }

      return out
    },
  }
}
