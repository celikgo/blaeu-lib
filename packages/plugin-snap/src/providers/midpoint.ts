import type {
  LngLat,
  ProjectedXY,
  SnapCandidate,
  SnapProvider,
  SnapQueryContext,
} from '@fleximap/core'
import { PRIORITY } from '../constants.js'
import { candidateAt, createScope, hint, segmentsNear, type SnapDeps } from '../geometry.js'

/**
 * Snap to the middle of an edge.
 *
 * Halving a boundary is one of the few constructions a surveyor does by eye often
 * enough that getting it exact matters — splitting a frontage, placing a party
 * wall, centring an access easement.
 *
 * The midpoint is taken in the plane, not on the sphere. On a 50 m edge the two
 * agree to well under a millimetre, so this is not about accuracy: it is about the
 * midpoint of an edge being *the same point* whichever provider computes it, so
 * that it quantises onto the same grid cell as the vertex-shared corner beside it.
 */
export function createMidpointProvider(deps: SnapDeps): SnapProvider {
  return {
    id: 'midpoint',
    priority: PRIORITY['midpoint'] ?? 80,

    query(point: LngLat, tolerancePx: number, ctx: SnapQueryContext): readonly SnapCandidate[] {
      const scope = createScope(deps, point, tolerancePx, ctx)
      const features = deps.cache.features(deps.store, ctx.bbox, ctx.exclude)
      const out: SnapCandidate[] = []

      for (const segment of segmentsNear(scope, features, scope.searchMetres)) {
        const middle: ProjectedXY = [
          (segment.a[0] + segment.b[0]) / 2,
          (segment.a[1] + segment.b[1]) / 2,
        ]

        const candidate = candidateAt(scope, 'midpoint', middle, {
          feature: segment.edge.feature,
          edge: segment.edge,
          hint: hint(deps, 'midpoint'),
        })
        if (candidate !== undefined) out.push(candidate)
      }

      return out
    },
  }
}
