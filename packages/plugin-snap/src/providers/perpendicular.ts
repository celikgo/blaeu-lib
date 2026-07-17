import {
  bboxAround,
  type LngLat,
  type SnapCandidate,
  type SnapProvider,
  type SnapQueryContext,
} from '@blaeu/core'
import { LINE_SEARCH_PX, PRIORITY } from '../constants.js'
import {
  candidateAt,
  createScope,
  footOnLine,
  hint,
  segmentsWhoseLineIsNear,
  type SnapDeps,
} from '../geometry.js'

/**
 * Snap to the point that makes the current segment **perpendicular** to a nearby
 * edge.
 *
 * The construction: take the last vertex the user committed in this gesture, drop a
 * perpendicular from it onto the edge's line, and offer the foot. Clicking there
 * closes the drawn segment at exactly 90° to that boundary — which is how buildings
 * meet plot lines, how easements cross roads, and how the overwhelming majority of
 * cadastral geometry is actually constructed.
 *
 * Without `ctx.inProgress` this provider has nothing to be perpendicular *from*, and
 * correctly returns nothing. That is not a degradation: a perpendicular needs two
 * points to be a perpendicular *to* anything, and inventing the first one would put
 * a vertex somewhere the user never aimed.
 *
 * The foot is left un-clamped: a perpendicular that lands past the end of the
 * boundary is still the geometrically right answer, and clamping it to the endpoint
 * would silently return a point that is *not* perpendicular to anything — the worst
 * kind of wrong, because it looks plausible.
 */
export function createPerpendicularProvider(deps: SnapDeps): SnapProvider {
  return {
    id: 'perpendicular',
    priority: PRIORITY['perpendicular'] ?? 50,

    query(point: LngLat, tolerancePx: number, ctx: SnapQueryContext): readonly SnapCandidate[] {
      const from = ctx.inProgress[ctx.inProgress.length - 1]
      if (from === undefined) return []

      const scope = createScope(deps, point, tolerancePx, ctx)
      const fromXY = scope.plane.forward(from)
      const searchMetres = LINE_SEARCH_PX * scope.metresPerPixel
      const features = deps.cache.features(
        deps.store,
        bboxAround(deps.crs, point, searchMetres),
        ctx.exclude,
      )

      const out: SnapCandidate[] = []
      for (const segment of segmentsWhoseLineIsNear(
        scope,
        features,
        scope.searchMetres,
        searchMetres,
      )) {
        const foot = footOnLine(fromXY, segment.a, segment.b)
        if (foot === undefined) continue

        const candidate = candidateAt(scope, 'perpendicular', foot.xy, {
          feature: segment.edge.feature,
          edge: segment.edge,
          hint: hint(deps, 'perpendicular'),
        })
        if (candidate !== undefined) out.push(candidate)
      }

      return out
    },
  }
}
