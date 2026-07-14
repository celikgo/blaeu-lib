/**
 * Repairs. Explicit ones, and only three of them.
 *
 * The list of what this file *cannot* fix is more important than what it can:
 *
 * - an **overlap** is two people claiming the same ground. "Fixing" it means
 *   deciding which parcel yields, which is a legal act, not a geometric one.
 * - a **gap** is unclaimed land. Closing it means giving that land to one of the
 *   two neighbours — see above.
 * - a **sliver** may be a right-of-way that genuinely exists.
 * - an **undersized parcel** is a fact about the world, not a defect in the data.
 *
 * Those four return `undefined`, forever, on purpose. What is left is repairable
 * because nobody ever *meant* it: a ring that does not close, a vertex digitised
 * twice, a boundary that crosses itself. Even these are only applied when a human
 * asks — `TopologyOptions.autoFix` is `false` by default.
 */

import {
  isRingClosed,
  planarDistance,
  type Geometry,
  type Position,
  type ProjectedCrs,
} from '@fleximap/core'

import { bufferZero, projectGeometry, read, toLngLat, unprojectGeometry, write } from './jsts.js'
import { RULE_IDS } from './rules.js'

/** The rules `fix()` can act on. Everything else is a decision for a surveyor. */
export const FIXABLE_RULE_IDS: ReadonlySet<string> = new Set([
  RULE_IDS.closedRings,
  RULE_IDS.duplicateVertices,
  RULE_IDS.selfIntersection,
])

/**
 * The repaired geometry, or `undefined` if this defect has no honest repair.
 *
 * Returns `undefined` — rather than the original — when nothing changed, so a
 * caller can tell "I fixed it" from "there was nothing I could do", and never
 * dispatch a command that writes a feature identical to the one already stored.
 */
export function repair(
  geometry: Geometry,
  ruleId: string,
  plane: ProjectedCrs,
  toleranceMetres: number,
): Geometry | undefined {
  switch (ruleId) {
    case RULE_IDS.closedRings:
      return closeRings(geometry)
    case RULE_IDS.duplicateVertices:
      return dedupeVertices(geometry, plane, toleranceMetres)
    case RULE_IDS.selfIntersection:
      return repairSelfIntersection(geometry, plane)
    default:
      return undefined
  }
}

/** Appends the first position to any ring that does not already end on it. */
function closeRings(geometry: Geometry): Geometry | undefined {
  let changed = false

  const closed = mapRings(geometry, (ring) => {
    const first = ring[0]
    if (first === undefined || ring.length < 3 || isRingClosed(ring)) return ring
    changed = true
    // A fresh array, never an alias of `first`: aliasing would make a later in-place
    // edit of the first vertex silently move the last one too.
    return [...ring, [...first]]
  })

  return changed ? closed : undefined
}

/**
 * Drops any vertex within `tolerance` metres of its predecessor.
 *
 * The distance is planar, in the working CRS. A degree-space comparison would
 * happily keep a 0.4 mm duplicate — the exact one that makes an overlay operation
 * throw three steps later.
 */
function dedupeVertices(
  geometry: Geometry,
  plane: ProjectedCrs,
  toleranceMetres: number,
): Geometry | undefined {
  let changed = false

  const deduped = mapRings(geometry, (ring) => {
    const kept: Position[] = []
    for (const position of ring) {
      const previous = kept[kept.length - 1]
      if (
        previous !== undefined &&
        planarDistance(plane.forward(toLngLat(previous)), plane.forward(toLngLat(position))) <=
          toleranceMetres
      ) {
        changed = true
        continue
      }
      kept.push(position)
    }

    // Deduping removed the closing coordinate along with the duplicate before it.
    // Put it back, or the "repair" leaves an unclosed ring — a different defect.
    const first = kept[0]
    if (first !== undefined && kept.length >= 3 && !isRingClosed(kept)) kept.push([...first])

    // Fewer than four positions is no longer a ring. Better to leave the defect
    // visible than to write a degenerate polygon that renders as nothing.
    return kept.length >= 4 ? kept : ring
  })

  return changed ? deduped : undefined
}

/**
 * `buffer(0)` in the projected plane: the standard self-intersection repair.
 *
 * It is a *lossy* repair. On a bowtie it returns both lobes as a MultiPolygon —
 * so the parcel's area changes, and a parcel whose area changed is a parcel whose
 * area on the deed is now wrong. This is precisely why it never runs on its own.
 */
function repairSelfIntersection(geometry: Geometry, plane: ProjectedCrs): Geometry | undefined {
  try {
    const repaired = bufferZero(read(projectGeometry(geometry, plane)))
    if (repaired.isEmpty()) return undefined

    const type = repaired.getGeometryType()
    if (type !== 'Polygon' && type !== 'MultiPolygon') return undefined

    return unprojectGeometry(write(repaired), plane)
  } catch {
    // JTS can fail outright on a sufficiently pathological ring. That is a report,
    // not a crash: the issue stays on the list, unfixed, and the surveyor sees it.
    return undefined
  }
}

/** Rebuilds a Polygon/MultiPolygon with each ring passed through `fn`. Anything else is returned untouched. */
function mapRings(geometry: Geometry, fn: (ring: Position[]) => Position[]): Geometry {
  switch (geometry.type) {
    case 'Polygon':
      return { type: 'Polygon', coordinates: geometry.coordinates.map(fn) }
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((part) => part.map(fn)),
      }
    default:
      return geometry
  }
}

/** So a UI can decide whether to *offer* the button before the surveyor presses it. */
export function isFixable(ruleId: string): boolean {
  return FIXABLE_RULE_IDS.has(ruleId)
}
