import type { Geometry, InteractionContext, Position } from '@blaeu/core'

import type { DrawSession } from '../session.js'
import { simplifyTrace } from '../simplify.js'
import type { DrawTool } from './tool.js'

/**
 * Press, trace, release. The captured path is simplified with Douglas-Peucker at
 * `freehandTolerance` **metres in the working CRS**, and stored as a `LineString`.
 *
 * The simplification is not a nicety. A trace is one vertex per pointer sample — thousands
 * of them, most closer together than the precision grid — and handing that to a topology
 * check, a boolean op, or a server produces spikes and slivers and a machine that looks
 * hung. The raw trace is a recording of a hand; the simplified line is a geometry.
 */
export function freehandTool(session: DrawSession): DrawTool {
  let tracing = false

  const abandon = (reason: string): void => {
    tracing = false
    session.cancel(reason)
  }

  return {
    id: 'draw:freehand',
    cursor: 'crosshair',

    activate: () => {
      tracing = false
      session.begin('freehand')
    },
    deactivate: () => {
      tracing = false
      session.end()
    },

    finish: () => {},

    onPointerDown(ctx: InteractionContext): boolean {
      tracing = true
      session.addVertex(ctx.lngLat)
      return true
    },

    onPointerMove(ctx: InteractionContext): boolean | void {
      if (!tracing) return
      session.addVertex(ctx.lngLat)
      // The preview shows the *raw* trace, not the simplified one: the user is watching
      // their own hand, and a line that snaps straight underneath the cursor while they are
      // still drawing it reads as the map fighting them. Simplification happens on release.
      session.setPreview(traceGeometry(session))
      return true
    },

    onPointerUp(ctx: InteractionContext): boolean | void {
      if (!tracing) return
      tracing = false
      session.addVertex(ctx.lngLat)

      const simplified = simplifyTrace(
        session.crs,
        session.distinctVertices(),
        session.options.freehandTolerance,
      )
      if (simplified.length < 2) {
        abandon('a freehand line needs at least 2 distinct vertices')
        return true
      }

      void session.complete({
        type: 'LineString',
        coordinates: simplified.map((p) => [...p]),
      })
      return true
    },

    onKeyDown(ctx: InteractionContext): boolean | void {
      if (ctx.key !== 'Escape') return
      abandon('cancelled by the user')
      return true
    },
  }
}

function traceGeometry(session: DrawSession): Geometry | null {
  const points = session.distinctVertices()
  const first = points[0]
  if (first === undefined) return null
  if (points.length === 1) return { type: 'Point', coordinates: [...first] }
  const coordinates: Position[] = points.map((p) => [...p])
  return { type: 'LineString', coordinates }
}
