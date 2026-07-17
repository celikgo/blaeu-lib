import type { FeatureProperties, InteractionContext, LngLat } from '@blaeu/core'

import type { DrawSession } from '../session.js'
import {
  CIRCLE_CENTRE_PROPERTY,
  CIRCLE_RADIUS_PROPERTY,
  CIRCLE_SEGMENTS_PROPERTY,
  CIRCLE_SHAPE_PROPERTY,
  circlePolygon,
  radiusMetres,
} from '../shapes.js'
import type { DrawTool } from './tool.js'

/**
 * Press at the centre, drag out the radius, release.
 *
 * The radius is a planar distance in metres in the working CRS — the number a surveyor
 * would dimension — and the shape that lands in the store is a polygon of
 * `circleSegments` vertices, because GeoJSON has no circle.
 *
 * That approximation is lossy, so the true centre and radius are stashed in the feature's
 * properties. An edit tool can then re-derive the exact circle instead of trying to recover
 * it from 64 vertices, each of which has been rounded to the precision grid.
 */
export function circleTool(session: DrawSession): DrawTool {
  let centre: LngLat | null = null

  const abandon = (reason: string): void => {
    centre = null
    session.cancel(reason)
  }

  return {
    id: 'draw:circle',
    cursor: 'crosshair',

    activate: () => {
      centre = null
      session.begin('circle')
    },
    deactivate: () => {
      centre = null
      session.end()
    },

    finish: () => {},

    onPointerDown(ctx: InteractionContext): boolean {
      centre = ctx.lngLat
      session.addVertex(centre)
      return true
    },

    onPointerMove(ctx: InteractionContext): boolean | void {
      if (centre === null) return
      const radius = radiusMetres(session.crs, centre, ctx.lngLat)
      if (!usable(session, radius)) {
        session.setPreview(null)
        return true
      }
      session.setPreview(circlePolygon(session.crs, centre, radius, session.options.circleSegments))
      return true
    },

    onPointerUp(ctx: InteractionContext): boolean | void {
      const origin = centre
      if (origin === null) return
      centre = null

      const radius = radiusMetres(session.crs, origin, ctx.lngLat)
      if (!usable(session, radius)) {
        abandon('a circle needs a radius larger than the working CRS precision grid')
        return true
      }

      const segments = session.options.circleSegments
      const properties: FeatureProperties = {
        [CIRCLE_SHAPE_PROPERTY]: 'circle',
        [CIRCLE_CENTRE_PROPERTY]: [origin[0], origin[1]],
        [CIRCLE_RADIUS_PROPERTY]: radius,
        [CIRCLE_SEGMENTS_PROPERTY]: segments,
      }
      void session.complete(circlePolygon(session.crs, origin, radius, segments), properties)
      return true
    },

    onKeyDown(ctx: InteractionContext): boolean | void {
      if (ctx.key !== 'Escape') return
      abandon('cancelled by the user')
      return true
    },
  }
}

/**
 * A circle smaller than the precision grid quantises into a ring with fewer than three
 * distinct corners, which the store refuses. Rejecting it here keeps the failure a
 * user-visible "nothing was drawn" rather than a thrown error from deep in ingest.
 */
function usable(session: DrawSession, radius: number): boolean {
  return radius > session.crs.working.precision
}
