import {
  distanceXY,
  eachVertex,
  toLngLat,
  type SnapCandidate,
  type SnapProvider,
  type SnapQueryContext,
  type LngLat,
} from '@blaeu/core'
import { PRIORITY } from '../constants.js'
import { candidateAtLngLat, createScope, hint, pointKey, type SnapDeps } from '../geometry.js'

/**
 * Snap to a corner.
 *
 * The highest-priority provider, and the one users notice when it is missing — a
 * corner is the only place on a parcel boundary that is *unambiguously* the same
 * place for two neighbours, which is why cadastral data is a graph of shared
 * corners rather than a pile of independent rings.
 *
 * It also snaps to the vertices of the gesture **in progress**, and that is not a
 * convenience: closing a ring means clicking its first vertex, and a snap engine
 * that only knew about committed features would leave the user chasing a corner
 * that is not in the store yet. Forgetting this is the single most common way a
 * from-scratch snap engine ships broken.
 */
export function createVertexProvider(deps: SnapDeps): SnapProvider {
  return {
    id: 'vertex',
    priority: PRIORITY['vertex'] ?? 100,

    query(point: LngLat, tolerancePx: number, ctx: SnapQueryContext): readonly SnapCandidate[] {
      const scope = createScope(deps, point, tolerancePx, ctx)
      const out: SnapCandidate[] = []
      const seen = new Set<string>()

      const push = (candidate: SnapCandidate | undefined): void => {
        if (candidate === undefined) return
        const key = pointKey(scope, candidate.point)
        // Two parcels sharing a corner offer the same candidate twice. The engine only
        // ever shows the winner, but `alternatives` is a user-facing list ("cycle snap
        // with Tab") and a list with the same corner in it four times is a bad list.
        if (seen.has(key)) return
        seen.add(key)
        out.push(candidate)
      }

      // The in-progress ring first, so that when a drawn vertex lands exactly on a
      // stored one — which is the normal case, because the previous click snapped to
      // it — the candidate the user gets back is the one they can close the ring on.
      for (const vertex of ctx.inProgress) {
        push(candidateAtLngLat(scope, 'vertex', vertex, { hint: hint(deps, 'vertex') }))
      }

      for (const feature of deps.cache.features(deps.store, ctx.bbox, ctx.exclude)) {
        eachVertex(feature.geometry, (part, ring, index, position) => {
          const lngLat = toLngLat(position)
          // Cheap metric reject before the (much more expensive) exact pixel measurement:
          // a 400-vertex parcel whose bbox meets the tolerance circle has, at most, a
          // couple of corners actually near the cursor.
          if (distanceXY(scope.cursorXY, scope.plane.forward(lngLat)) > scope.searchMetres) return

          push(
            candidateAtLngLat(scope, 'vertex', lngLat, {
              feature: feature.id,
              vertex: { feature: feature.id, part, ring, index },
              hint: hint(deps, 'vertex'),
            }),
          )
        })
      }

      return out
    },
  }
}
