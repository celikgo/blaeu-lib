import {
  snapXYToGrid,
  type LngLat,
  type SnapCandidate,
  type SnapProvider,
  type SnapQueryContext,
} from '@fleximap/core'
import { PRIORITY } from '../constants.js'
import { candidateAt, createScope, hint, type SnapDeps } from '../geometry.js'

/**
 * Snap to a regular grid, in the **working CRS**, in metres.
 *
 * In the working CRS, not in degrees — a "10 metre" grid built on longitude is a
 * grid of 10 m × 13 m cells at Ankara and 10 m × 20 m cells in Oslo, which is not a
 * grid, it is a rhombus generator.
 *
 * Priority 10, the floor: a grid candidate exists *everywhere*, so if it outranked
 * anything real the user could never snap to a corner that happened to sit off-grid
 * — which is every corner in every dataset that was not itself drawn on this grid.
 */
export function createGridProvider(deps: SnapDeps): SnapProvider {
  return {
    id: 'grid',
    priority: PRIORITY['grid'] ?? 10,

    query(point: LngLat, tolerancePx: number, ctx: SnapQueryContext): readonly SnapCandidate[] {
      if (!(deps.gridSize > 0)) return []

      const scope = createScope(deps, point, tolerancePx, ctx)
      const cell = snapXYToGrid(scope.cursorXY, deps.gridSize)

      const candidate = candidateAt(scope, 'grid', cell, { hint: hint(deps, 'grid') })
      return candidate === undefined ? [] : [candidate]
    },
  }
}
