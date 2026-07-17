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
 * Snap to the infinite continuation of an existing edge.
 *
 * Surveyors live on this one. "Extend the north boundary until it meets the road"
 * is a sentence that describes an afternoon's work, and without an extension snap
 * the software's answer is "eyeball it" — which is precisely the thing the software
 * exists to prevent.
 *
 * Note the search: it is **not** the tolerance circle. The edge being extended is
 * usually nowhere near the pointer — it may be on the far side of the parcel — and
 * only its continuation comes close. So this provider queries a wider box
 * ({@link LINE_SEARCH_PX}) and then filters on the distance from the cursor to the
 * *line*, which is a different question from the distance to the *segment*.
 *
 * Only points genuinely *beyond* an endpoint are offered (`t < 0 || t > 1`). Inside
 * the segment, the same point is an edge snap, and the edge provider owns it — at a
 * higher priority, correctly, because a point on a real boundary beats a point on an
 * imaginary line through it.
 */
export function createExtensionProvider(deps: SnapDeps): SnapProvider {
  return {
    id: 'extension',
    priority: PRIORITY['extension'] ?? 50,

    query(point: LngLat, tolerancePx: number, ctx: SnapQueryContext): readonly SnapCandidate[] {
      const scope = createScope(deps, point, tolerancePx, ctx)
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
        const foot = footOnLine(scope.cursorXY, segment.a, segment.b)
        if (foot === undefined) continue
        if (foot.t >= 0 && foot.t <= 1) continue

        const candidate = candidateAt(scope, 'extension', foot.xy, {
          feature: segment.edge.feature,
          edge: segment.edge,
          hint: hint(deps, 'extension'),
        })
        if (candidate !== undefined) out.push(candidate)
      }

      return out
    },
  }
}
