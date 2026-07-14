/**
 * `edit:split` — draw the cut line, then finish.
 *
 * Click to lay down points, double-click or press Enter to cut, Escape to abandon.
 * The cut itself is `EditController.split`, which refuses a line that does not fully
 * cross the parcel rather than producing a "split" that changed nothing.
 *
 * The tool *catches* that refusal and reports it, where the API method throws. That
 * asymmetry is deliberate: a script calling `edit.split()` wants an exception it can
 * handle, while a surveyor who drew a bad line wants a message and their line still
 * on screen — not a stack trace out of a pointer handler.
 */

import type { FeatureId, LineString, LngLat, PluginContext, Tool } from '@fleximap/core'
import type { EditController } from '../controller.js'

export function splitTool(ctx: PluginContext<unknown>, controller: EditController): Tool {
  let points: LngLat[] = []
  let target: FeatureId | null = null

  const preview = (): void => {
    if (points.length < 2) {
      controller.handles.setGuide(undefined)
      return
    }
    controller.handles.setGuide({
      type: 'LineString',
      coordinates: points.map(([lng, lat]) => [lng, lat]),
    })
  }

  const reset = (): void => {
    points = []
    controller.handles.setGuide(undefined)
  }

  const finish = (): void => {
    const line: LineString = {
      type: 'LineString',
      coordinates: points.map(([lng, lat]) => [lng, lat]),
    }
    const id = target ?? controller.targets()[0]

    if (id === undefined || points.length < 2) {
      ctx.log.warn(
        'nothing to split: select or edit a feature first, and click at least twice to draw the cut line.',
      )
      return
    }

    try {
      controller.split(id, line)
      reset()
      target = null
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      // Surfaced as an event, not thrown: the host app's error toast listens to
      // `map:error`, and a refused cut is exactly what it exists to show.
      ctx.events.emit('map:error', { error, source: 'edit:split' })
      ctx.log.error(error.message)
    }
  }

  return {
    id: 'edit:split',
    cursor: 'crosshair',

    activate(): void {
      // Keep whatever guide we draw, and make sure vertex handles are not left over
      // from the previous tool — a cut line drawn through a thicket of handles is
      // impossible to see.
      controller.setHandleRenderer(() => controller.handles.set([]))
      target = controller.targets()[0] ?? null
      reset()
    },

    deactivate(): void {
      reset()
      target = null
      controller.setHandleRenderer(undefined)
    },

    onClick(interaction): boolean {
      if (target === null) {
        // The first click of a cut is usually *outside* the parcel (the line has to
        // cross the boundary twice), so falling back to "whatever is under the first
        // click" would pick nothing. Only adopt a target if the user genuinely hit one.
        const feature = controller.featureAt(interaction.lngLat, controller.options.handleSize)
        if (feature !== undefined) target = feature.id
      }

      // Already snapped, if a snap plugin is installed: a cut line that starts exactly
      // on a neighbouring parcel's corner is the whole point of snapping.
      points.push(interaction.lngLat)
      preview()
      return true
    },

    onDblClick(): boolean {
      finish()
      return true
    },

    onKeyDown(interaction): boolean {
      if (interaction.key === 'Enter') {
        finish()
        return true
      }
      if (interaction.key === 'Escape') {
        reset()
        return true
      }
      return false
    },
  }
}
