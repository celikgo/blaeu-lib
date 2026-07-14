import type { InteractionContext, LngLat } from '@fleximap/core'

import type { DrawSession } from '../session.js'
import { degenerateRectangle, rectanglePolygon } from '../shapes.js'
import type { DrawTool } from './tool.js'

/**
 * Press, drag, release. The rectangle is axis-aligned **in the working CRS**, not in
 * lng/lat — see {@link rectanglePolygon} for why that distinction is the whole tool.
 */
export function rectangleTool(session: DrawSession): DrawTool {
  let origin: LngLat | null = null

  const abandon = (reason: string): void => {
    origin = null
    session.cancel(reason)
  }

  return {
    id: 'draw:rectangle',
    cursor: 'crosshair',

    activate: () => {
      origin = null
      session.begin('rectangle')
    },
    deactivate: () => {
      origin = null
      session.end()
    },

    // A rectangle is a single gesture: there is no state a toolbar button could finish that
    // releasing the pointer does not already finish.
    finish: () => {},

    onPointerDown(ctx: InteractionContext): boolean {
      origin = ctx.lngLat
      // Recorded as a vertex so `DrawApi.vertices` and the snap engine's in-progress set
      // both know where the gesture is anchored.
      session.addVertex(origin)
      return true
    },

    onPointerMove(ctx: InteractionContext): boolean | void {
      if (origin === null) return
      if (degenerateRectangle(session.crs, origin, ctx.lngLat)) {
        // Thinner than one quantisation step in either axis: the ring would collapse to a
        // line on ingest. Show nothing rather than flash a shape the store would reject.
        session.setPreview(null)
        return true
      }
      session.setPreview(rectanglePolygon(session.crs, origin, ctx.lngLat))
      return true
    },

    onPointerUp(ctx: InteractionContext): boolean | void {
      const start = origin
      if (start === null) return
      origin = null

      if (degenerateRectangle(session.crs, start, ctx.lngLat)) {
        // A click without a drag. Not an error — the user changed their mind, or missed.
        abandon('a rectangle needs two corners with area between them')
        return true
      }

      void session.complete(rectanglePolygon(session.crs, start, ctx.lngLat))
      return true
    },

    onKeyDown(ctx: InteractionContext): boolean | void {
      if (ctx.key !== 'Escape') return
      abandon('cancelled by the user')
      return true
    },
  }
}
