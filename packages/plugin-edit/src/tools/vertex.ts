/**
 * `edit:vertex` — the default editing mode.
 *
 * Drag a vertex to move it, click a midpoint to insert one, Alt-click (or Delete)
 * to remove one. That is the whole tool, and it is short because everything hard
 * happened elsewhere: the position it reads has already been snapped by middleware
 * it has never heard of, and the geometry it writes goes through a command that
 * knows about shared corners.
 */

import {
  createId,
  type InteractionContext,
  type LngLat,
  type PluginContext,
  type Tool,
  type VertexRef,
} from '@blaeu/core'
import type { EditController } from '../controller.js'
import { refOf, type Handle } from '../handles.js'

interface VertexDrag {
  readonly refs: readonly VertexRef[]
  /** Where the vertex was when the gesture began. Every frame is computed from here, never from the last one. */
  readonly from: LngLat
  readonly gesture: string
}

export function vertexTool(ctx: PluginContext<unknown>, controller: EditController): Tool {
  let drag: VertexDrag | null = null
  /** The vertex the Delete key acts on. Held as a ref, not a Handle: handles are rebuilt on every change. */
  let active: VertexRef | null = null

  const handleAt = (interaction: InteractionContext): Handle | undefined =>
    controller.handles.pick(interaction.screen, controller.options.handleSize)

  const beginDrag = (refs: readonly VertexRef[], from: LngLat, gesture: string): void => {
    if (refs.length === 0) return
    drag = { refs, from, gesture }
    active = refs[0] ?? null

    // Tell the kernel what is in play for the duration of the gesture. Without this a
    // snapping middleware sees the corner we are dragging sitting under the cursor,
    // helpfully snaps the pointer back onto it, and the vertex never moves — so every
    // drag shorter than the snap tolerance is a silent no-op. In topological mode the
    // gesture holds *several* parcels (they share the corner), so declare all of them.
    //
    // Note what this is not: a call into the snap plugin. This tool has never heard of
    // it. It states a fact on a kernel type and any middleware may act on it.
    ctx.tools.setDragging([...new Set(refs.map((ref) => ref.feature))])
  }

  /** Release: end the gesture and commit its net effect once, through the pipeline. */
  const endDrag = (): void => {
    drag = null
    ctx.tools.setDragging([])
    controller.commitGesture()
  }

  /**
   * A refused edit — a ring that would fall below three corners, say — is a message,
   * not an exception. Letting it out of a pointer handler would unwind through the
   * renderer's event dispatch and take the map's interaction loop with it, which
   * turns "you can't delete that corner" into "the map has stopped working".
   */
  const attempt = (action: () => void): void => {
    try {
      action()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      ctx.events.emit('map:error', { error, source: 'edit:vertex' })
      ctx.log.warn(error.message)
    }
  }

  return {
    id: 'edit:vertex',
    cursor: 'crosshair',

    activate(): void {
      controller.setHandleRenderer(undefined)
    },

    deactivate(): void {
      // Commit any drag in flight rather than lose it when the tool is switched away.
      drag = null
      active = null
      controller.commitGesture()
    },

    onPointerDown(interaction): boolean {
      const handle = handleAt(interaction)

      if (handle === undefined) {
        // Nothing grabbable under the pointer: treat the click as "edit that one
        // instead", which is what a user who clicks a neighbouring parcel means.
        const feature = controller.featureAt(interaction.lngLat, controller.options.handleSize)
        if (feature !== undefined && feature.id !== controller.editing) {
          attempt(() => controller.edit(feature.id))
          return true
        }
        return false
      }

      if (handle.role === 'vertex') {
        if (interaction.modifiers.alt && controller.options.allowVertexDelete) {
          attempt(() => controller.deleteVertex(handle))
          return true
        }
        beginDrag(controller.refsAt(handle.point, refOf(handle)), handle.point, createId())
        return true
      }

      if (handle.role === 'midpoint') {
        // Insert, then keep dragging the vertex that was just created — the gesture a
        // user is already making when they grab a midpoint is "pull the edge to here".
        // One gesture id spans the insert and the drag, so they commit as one step.
        const gesture = createId()
        attempt(() =>
          beginDrag(controller.insertVertex(handle, handle.point, gesture), handle.point, gesture),
        )
        return true
      }

      return false
    },

    onPointerMove(interaction): boolean {
      if (drag === null) return false
      // `interaction.lngLat` is already snapped — the snap plugin rewrote it in the
      // interaction pipeline before this tool ever saw the event. Do not go looking
      // for snapping here.
      controller.moveVertices(drag.refs, drag.from, interaction.lngLat, drag.gesture)
      return true
    },

    onPointerUp(): boolean {
      if (drag === null) return false
      endDrag()
      return true
    },

    onKeyDown(interaction): boolean {
      if (interaction.key === 'Escape') {
        // Escape cancels: roll the preview back to the pre-drag geometry rather than
        // commit it, then leave the session.
        drag = null
        ctx.tools.setDragging([])
        controller.cancelGesture()
        controller.stop()
        return true
      }

      const isDelete = interaction.key === 'Delete' || interaction.key === 'Backspace'
      if (isDelete && controller.options.allowVertexDelete) {
        if (active === null) return false
        // Re-pick the live handle: the one we grabbed is a snapshot from before the
        // last edit, and its coordinate may be stale by a whole drag.
        const handle = controller.handles
          .handles()
          .find(
            (candidate) =>
              candidate.role === 'vertex' &&
              candidate.target === active?.feature &&
              candidate.part === active.part &&
              candidate.ring === active.ring &&
              candidate.index === active.index,
          )
        if (handle === undefined) return false
        attempt(() => controller.deleteVertex(handle))
        active = null
        return true
      }

      return false
    },
  }
}
