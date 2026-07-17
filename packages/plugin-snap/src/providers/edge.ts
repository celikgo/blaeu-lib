import type { LngLat, SnapCandidate, SnapProvider, SnapQueryContext } from '@blaeu/core'
import { PRIORITY } from '../constants.js'
import {
  candidateAt,
  createScope,
  footOnSegment,
  hint,
  segmentsNear,
  type SnapDeps,
} from '../geometry.js'

/**
 * Snap to the nearest point *on* an edge — the perpendicular foot.
 *
 * The foot is computed in the **projected working CRS, in metres** (core invariant
 * 3, and the `gis-geometry-precision` skill). The same computation on lng/lat is
 * not merely imprecise, it is *wrong in a specific direction*: a degree of
 * longitude at Ankara is ~85 km against ~111 km for a degree of latitude, so an
 * un-projected foot is pulled along the parallel by a factor of 1.3. On a 50 m
 * boundary that is a 30 cm error. It renders perfectly.
 *
 * Priority 70: below the corners and midpoints that lie *on* this very edge and are
 * exactly as close, and above the grid.
 */
export function createEdgeProvider(deps: SnapDeps): SnapProvider {
  return {
    id: 'edge',
    priority: PRIORITY['edge'] ?? 70,

    query(point: LngLat, tolerancePx: number, ctx: SnapQueryContext): readonly SnapCandidate[] {
      const scope = createScope(deps, point, tolerancePx, ctx)
      const features = deps.cache.features(deps.store, ctx.bbox, ctx.exclude)
      const out: SnapCandidate[] = []

      for (const segment of segmentsNear(scope, features, scope.searchMetres)) {
        const foot = footOnSegment(scope.cursorXY, segment.a, segment.b)
        if (foot === undefined) continue

        const candidate = candidateAt(scope, 'edge', foot.xy, {
          feature: segment.edge.feature,
          edge: segment.edge,
          hint: hint(deps, 'edge'),
        })
        if (candidate !== undefined) out.push(candidate)
      }

      return out
    },
  }
}
