import type { InteractionContext, LngLat, PluginContext, ScreenPoint, Tool } from '@fleximap/core'
import { boxRing, closeRing } from './geometry.js'
import type { SelectionController, SelectMode } from './SelectionController.js'

export const SINGLE_TOOL = 'select:single'
export const BOX_TOOL = 'select:box'
export const LASSO_TOOL = 'select:lasso'

/** Freehand points closer together than this add nothing but vertices. */
const LASSO_MIN_STEP_PX = 3

/* ========================================================================= */
/* Single click                                                              */
/* ========================================================================= */

export function singleTool(controller: SelectionController): Tool {
  return {
    id: SINGLE_TOOL,
    cursor: 'pointer',
    activate: () => {},
    deactivate: () => {},

    onClick(ctx: InteractionContext): boolean {
      const mode = controller.modeFor(ctx, 'toggle')
      const feature = controller.pick(ctx.hits())

      if (feature === undefined) {
        // A click on empty space clears — but only a *plain* one. Missing a parcel by
        // three pixels while shift-building a set of twelve must not throw the set away.
        if (mode === 'replace') controller.clear()
        return true
      }

      controller.select(feature.id, mode)
      return true
    },
  }
}

/* ========================================================================= */
/* Box drag                                                                  */
/* ========================================================================= */

interface Anchor {
  readonly screen: ScreenPoint
  readonly mode: SelectMode
}

export function boxTool(ctx: PluginContext<unknown>, controller: SelectionController): Tool {
  let anchor: Anchor | undefined

  const reset = (): void => {
    anchor = undefined
    controller.overlay.clearPreview()
  }

  return {
    id: BOX_TOOL,
    cursor: 'crosshair',
    activate: () => {},
    deactivate: reset,

    onPointerDown(ictx: InteractionContext): boolean {
      // The modifiers are read at press, not at release: a user who presses shift,
      // drags, and lets go of shift a moment before the mouse button still meant to add.
      anchor = { screen: ictx.screen, mode: controller.modeFor(ictx, 'add') }
      return true
    },

    onPointerMove(ictx: InteractionContext): boolean | void {
      if (anchor === undefined) return
      controller.overlay.setPreview(
        boxRing(anchor.screen, ictx.screen, (p) => ctx.renderer.unproject(p)),
      )
      return true
    },

    onPointerUp(ictx: InteractionContext): boolean | void {
      const from = anchor
      if (from === undefined) return
      reset()

      const travelled = Math.hypot(ictx.screen.x - from.screen.x, ictx.screen.y - from.screen.y)
      if (travelled < ctx.config.interaction.dragThreshold) {
        // A press that never moved is a click. A box tool that ignored it would force
        // the user to switch tools to select one thing, which nobody does twice.
        clickSelect(controller, ictx, from.mode)
        return true
      }

      // `queryInBox` and not a store query: what the user boxed is what they can *see*,
      // and the renderer is the only thing that knows what is currently drawn.
      const hits = ctx.renderer.queryInBox(from.screen, ictx.screen)
      controller.select(controller.selectableIds(hits), from.mode)
      return true
    },

    onKeyDown(ictx: InteractionContext): boolean | void {
      if (ictx.key !== 'Escape' || anchor === undefined) return
      reset()
      return true
    },
  }
}

/* ========================================================================= */
/* Lasso                                                                     */
/* ========================================================================= */

export function lassoTool(ctx: PluginContext<unknown>, controller: SelectionController): Tool {
  let trace: LngLat[] | undefined
  let last: ScreenPoint | undefined
  let mode: SelectMode = 'replace'

  const reset = (): void => {
    trace = undefined
    last = undefined
    controller.overlay.clearPreview()
  }

  return {
    id: LASSO_TOOL,
    cursor: 'crosshair',
    activate: () => {},
    deactivate: reset,

    onPointerDown(ictx: InteractionContext): boolean {
      // `rawLngLat`, not `lngLat`: a lasso is a gesture, not a construction. Snapping
      // its trace to parcel corners would make the boundary of the selection jump
      // around, and the user is drawing a region, not a geometry anyone will keep.
      trace = [ictx.rawLngLat]
      last = ictx.screen
      mode = controller.modeFor(ictx, 'add')
      return true
    },

    onPointerMove(ictx: InteractionContext): boolean | void {
      if (trace === undefined) return

      // Thin the trace in *screen* space: a slow hand emits a hundred pointermoves
      // inside one pixel, and every one of them would become a lasso vertex that
      // point-in-polygon then pays for.
      if (last !== undefined) {
        const step = Math.hypot(ictx.screen.x - last.x, ictx.screen.y - last.y)
        if (step < LASSO_MIN_STEP_PX) return true
      }

      trace.push(ictx.rawLngLat)
      last = ictx.screen
      controller.overlay.setPreview(trace)
      return true
    },

    onPointerUp(ictx: InteractionContext): boolean | void {
      const points = trace
      const gestureMode = mode
      if (points === undefined) return
      reset()

      const ring = closeRing(points)
      if (ring === undefined) {
        // Too few points to bound anything: the user tapped. Treat it as a click rather
        // than as an empty lasso that silently clears their selection.
        clickSelect(controller, ictx, gestureMode)
        return true
      }

      controller.select(controller.idsInRing(ring), gestureMode)
      return true
    },

    onKeyDown(ictx: InteractionContext): boolean | void {
      if (ictx.key !== 'Escape' || trace === undefined) return
      reset()
      return true
    },
  }
}

/* ========================================================================= */

/** What a drag tool does when the drag turned out to be a click. */
function clickSelect(
  controller: SelectionController,
  ctx: InteractionContext,
  mode: SelectMode,
): void {
  const feature = controller.pick(ctx.hits())
  if (feature === undefined) {
    if (mode === 'replace') controller.clear()
    return
  }
  // 'add' would make a second click on the same parcel a no-op, which reads as a
  // dead tool. On a single feature the multi-modifier means toggle.
  controller.select(feature.id, mode === 'add' ? 'toggle' : mode)
}
