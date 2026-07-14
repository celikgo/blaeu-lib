import type { Geometry, InteractionContext, LngLat, Position } from '@fleximap/core'

import type { DrawSession } from '../session.js'
import type { DrawTool } from './tool.js'

/** How near the first vertex a click has to land to close the ring. Pixels, because that is what "near" means to a hand. */
export const CLOSE_TOLERANCE_PX = 12

/**
 * The shared body of the line and polygon tools: click to add a vertex, double-click to
 * finish, Escape to abandon, Backspace to take the last vertex back.
 *
 * They differ in exactly three things — how many corners they need, whether clicking the
 * first vertex closes the shape, and what geometry comes out — so they share a body rather
 * than a copy. `tools/line.ts` and `tools/polygon.ts` are the two files that name them.
 */
export function sequenceTool(session: DrawSession, mode: 'line' | 'polygon'): DrawTool {
  const minimumVertices = mode === 'polygon' ? 3 : 2
  const closable = mode === 'polygon'

  const finish = (): void => {
    const points = session.distinctVertices()
    if (points.length < minimumVertices) {
      // Deliberately not silent. A double-click that produces nothing looks like a broken
      // map; a log line plus a `draw:cancel` gives the UI something to say.
      const reason =
        `a ${mode} needs at least ${minimumVertices} distinct corners, but only ${points.length} ` +
        `survived snapping to the working CRS's precision grid`
      session.log.warn(`draw:${mode} not completed — ${reason}.`)
      session.cancel(reason)
      return
    }
    void session.complete(geometryOf(mode, points))
  }

  return {
    id: `draw:${mode}`,
    cursor: 'crosshair',

    activate: () => session.begin(mode),
    deactivate: () => session.end(),

    finish,

    onClick(ctx: InteractionContext): boolean {
      const point = ctx.lngLat

      // Closing on the first vertex is the *reason* the session tells the snap engine what
      // is in progress: with snapping installed, `ctx.lngLat` has already been pulled onto
      // that first vertex, so this test is exact rather than approximate.
      if (closable && session.distinctVertices().length >= minimumVertices && closes(point)) {
        finish()
        return true
      }

      session.addVertex(point)
      session.setPreview(previewGeometry(session, mode, undefined))
      return true
    },

    onPointerMove(ctx: InteractionContext): boolean | void {
      if (session.vertices.length === 0) return
      // The rubber band: everything committed, plus a live segment to the cursor.
      session.setPreview(previewGeometry(session, mode, ctx.lngLat))
      return true
    },

    onDblClick(): boolean {
      // In a browser a dblclick arrives *after* two clicks, so the last vertex has already
      // been added twice at (nearly) the same place. `distinctVertices()` collapses it on
      // the precision grid, which is why `finish` counts corners rather than clicks.
      finish()
      return true
    },

    onKeyDown(ctx: InteractionContext): boolean | void {
      switch (ctx.key) {
        case 'Escape':
          session.cancel('cancelled by the user')
          return true
        case 'Enter':
          finish()
          return true
        case 'Backspace':
        case 'Delete': {
          if (!session.popVertex()) return
          session.setPreview(previewGeometry(session, mode, undefined))
          return true
        }
        default:
          return
      }
    },
  }

  function closes(point: LngLat): boolean {
    const first = session.vertices[0]
    if (first === undefined) return false
    return session.screenDistance(first, point) <= CLOSE_TOLERANCE_PX
  }
}

/**
 * The preview is always a `Point` or a `LineString`, never a `Polygon` — even for the
 * polygon tool.
 *
 * A half-drawn ring is routinely self-intersecting and routinely has two corners, and the
 * store's ingest normaliser (rightly) refuses both. Previewing the ring as a line, closed
 * back to its first corner once it has three, shows the user exactly the same shape and
 * cannot throw. A preset that wants a translucent fill can style the preview collection.
 */
function previewGeometry(
  session: DrawSession,
  mode: 'line' | 'polygon',
  cursor: LngLat | undefined,
): Geometry | null {
  const points = session.distinctVertices(...(cursor === undefined ? [] : [cursor]))
  const first = points[0]
  if (first === undefined) return null
  if (points.length === 1) return { type: 'Point', coordinates: [...first] }

  const coordinates: Position[] = points.map((p) => [...p])
  if (mode === 'polygon' && points.length >= 3) coordinates.push([...first])
  return { type: 'LineString', coordinates }
}

function geometryOf(mode: 'line' | 'polygon', points: readonly LngLat[]): Geometry {
  const coordinates: Position[] = points.map((p) => [...p])
  if (mode === 'line') return { type: 'LineString', coordinates }
  return { type: 'Polygon', coordinates: [[...coordinates, [...coordinates[0]!]]] }
}
