import type { InteractionContext } from '@blaeu/core'

import type { DrawSession } from '../session.js'
import type { DrawTool } from './tool.js'

/**
 * One click, one point. The simplest tool in the library, and a useful reading of what a
 * tool is: it decides *when* a shape is done and *what* it is, and hands it to the session.
 *
 * Note the absence of any snapping code. `ctx.lngLat` has already been snapped to a parcel
 * corner, locked to a grid, or constrained — by middleware this file has never heard of.
 */
export function pointTool(session: DrawSession): DrawTool {
  return {
    id: 'draw:point',
    cursor: 'crosshair',

    activate: () => session.begin('point'),
    deactivate: () => session.end(),

    // Nothing is ever "in progress" for a point: the click that starts it also ends it.
    finish: () => {},

    onClick(ctx: InteractionContext): boolean {
      void session.complete({ type: 'Point', coordinates: [...ctx.lngLat] })
      return true
    },

    onKeyDown(ctx: InteractionContext): boolean | void {
      if (ctx.key !== 'Escape') return
      session.cancel('cancelled by the user')
      return true
    },
  }
}
