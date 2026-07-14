import type { SnapKind } from '@fleximap/core'

/**
 * Candidate priorities, and the one ordering decision the whole engine rests on.
 *
 * **A vertex must outrank the edge it sits on.** The perpendicular foot of the
 * pointer on an edge is, when the pointer is near a corner, at *exactly* the same
 * screen distance as the corner itself — so a tie broken by distance alone would
 * hand a coin-flip to the edge, and no user could ever reliably snap to a corner.
 * The same argument puts an intersection above a midpoint above an edge: the more
 * *specific* a target is, the more deliberate the user's aim at it must have been.
 *
 * Grid sits at the bottom because it exists everywhere: a grid candidate is always
 * available, so anything real must beat it.
 */
export const PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  vertex: 100,
  intersection: 90,
  midpoint: 80,
  edge: 70,
  extension: 50,
  perpendicular: 50,
  grid: 10,
})

/** The built-ins, in the order they are registered. Ids double as {@link SnapKind}s. */
export const BUILTIN_KINDS: readonly SnapKind[] = [
  'vertex',
  'intersection',
  'midpoint',
  'edge',
  'extension',
  'perpendicular',
  'grid',
]

/** Screen pixels. Ten is roughly a fingertip's worth of aim on a desktop mouse. */
export const DEFAULT_TOLERANCE_PX = 10

/**
 * Snapping runs first, at 100.
 *
 * Everything downstream — grid lock, ortho constraint, the tool itself — reads a
 * position that has already been snapped. Putting a constraint *above* snapping
 * would let it move the pointer off the corner the indicator is promising, which
 * the user reads as the software lying to them.
 */
export const MIDDLEWARE_PRIORITY = 100

/** The renderer source and layer the indicator owns. Namespaced; nothing else may write to them. */
export const INDICATOR_SOURCE = 'snap:indicator'
export const INDICATOR_LAYER = 'snap:indicator'

/**
 * How far, in pixels, the extension and perpendicular providers look for the edge
 * whose *line* passes near the pointer.
 *
 * They cannot use the tolerance circle: the whole point of an extension snap is
 * that the edge itself is somewhere else — often off the far side of the parcel —
 * and only its infinite continuation comes near the cursor.
 */
export const LINE_SEARCH_PX = 300

/**
 * Slack on the metric pre-filter that keeps a candidate from being computed for a
 * segment that cannot possibly produce one.
 *
 * The filter is in projected metres, the tolerance is in screen pixels, and the
 * two are related by a scale that varies across the viewport (and, under a
 * rotated or high-latitude view, is anisotropic). 1.5× is comfortably more than
 * that variation over a tolerance-sized neighbourhood, and every survivor is then
 * re-measured *exactly* in pixels — so the slack costs a few wasted projections
 * and can never let a real candidate through the net.
 */
export const SEARCH_SLACK = 1.5
