/**
 * `edit:merge` — click the parcels to merge, then finish.
 *
 * Seeds itself from the selection when a select plugin is installed, so the common
 * path ("select two parcels, hit merge") is a single click. Without one it is still
 * usable: click each parcel in turn.
 *
 * Contiguity is enforced by `EditController.merge`, and a refusal is reported rather
 * than thrown — same reasoning as the split tool.
 */

import type { FeatureId, PluginContext, Tool } from '@fleximap/core'
import type { EditController } from '../controller.js'

export function mergeTool(ctx: PluginContext<unknown>, controller: EditController): Tool {
  let picked: FeatureId[] = []

  const finish = (): void => {
    if (picked.length < 2) {
      ctx.log.warn(
        `merge needs at least two features; ${picked.length} picked. Click each parcel to add it, then press Enter.`,
      )
      return
    }

    try {
      controller.merge(picked)
      picked = []
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      ctx.events.emit('map:error', { error, source: 'edit:merge' })
      ctx.log.error(error.message)
    }
  }

  return {
    id: 'edit:merge',
    cursor: 'pointer',

    activate(): void {
      controller.setHandleRenderer(() => controller.handles.set([]))
      picked = [...controller.targets()]
    },

    deactivate(): void {
      picked = []
      controller.setHandleRenderer(undefined)
    },

    onClick(interaction): boolean {
      const feature = controller.featureAt(interaction.lngLat, controller.options.handleSize)
      if (feature === undefined) return false

      // Clicking an already-picked parcel removes it. Merging is destructive and
      // irreversible-looking to a user even though it is undoable, so it must be
      // trivially easy to take one back out of the pile before committing.
      picked = picked.includes(feature.id)
        ? picked.filter((id) => id !== feature.id)
        : [...picked, feature.id]
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
        picked = []
        return true
      }
      return false
    },
  }
}
