/**
 * `@blaeu/plugin-edit` — vertex editing, transforms, split and merge.
 *
 * The cadastre-critical plugin. Two decisions in here are the reason it exists at
 * all, and both are about *not* losing a millimetre:
 *
 * - **Topological editing.** With `topological: true`, dragging a corner shared by
 *   two parcels moves it in both, in one command, so undo restores both. Anything
 *   else lets adjacent parcels drift apart, and a 3 cm gap between two parcels is
 *   not a rendering artefact — it is a strip of land with no owner.
 *
 * - **No float accumulation.** Every frame of a drag is computed from the geometry
 *   as it was when the drag *started*, plus the total delta. A drag that chained 200
 *   incremental transforms would compound 200 rounding errors, and the vertex would
 *   land somewhere the surveyor did not put it.
 */

import type { FeatureId, BlaeuFeature, BlaeuPlugin, LngLat, VertexRef } from '@blaeu/core'

import { EditController, createApi } from './controller.js'
import { en, tr } from './messages.js'
import { mergeTool } from './tools/merge.js'
import { splitTool } from './tools/split.js'
import { transformTool } from './tools/transform.js'
import { vertexTool } from './tools/vertex.js'
import { HANDLE_COLLECTIONS } from './handles.js'
import type { EditApi, EditOptions, ResolvedEditOptions } from './types.js'

export type { EditApi, EditOptions, ResolvedEditOptions } from './types.js'
export {
  GeometryEditCommand,
  MoveVerticesCommand,
  SetGeometriesCommand,
  type EditCommandOptions,
} from './commands.js'
export {
  VERTEX_COLLECTION,
  MIDPOINT_COLLECTION,
  GUIDE_COLLECTION,
  HANDLE_COLLECTIONS,
  type Handle,
  type HandleRole,
} from './handles.js'

/**
 * Registers the `edit:*` tools and returns the editing API.
 *
 * ```ts
 * const map = await createBlaeuMap({
 *   container: '#map',
 *   plugins: [snapPlugin(), editPlugin({ topological: true })],
 * })
 * map.plugin('edit').edit('parcel-42')   // typed as EditApi — no cast
 * ```
 */
export function editPlugin(options: EditOptions = {}): BlaeuPlugin<EditApi, EditOptions> {
  return {
    id: 'edit',
    version: '1.0.0',
    dependencies: [
      // All optional, and all genuinely so. Snapping *enhances* editing — the position
      // the tools read has already been snapped, by middleware they never see. Selection
      // gives the transform gizmo more than one feature to work on. History turns a
      // coalesced drag into one Ctrl-Z. Without any of them the plugin still edits
      // geometry correctly, which the degradation test exists to prove.
      { id: 'snap', optional: true },
      { id: 'select', optional: true },
      { id: 'history', optional: true },
    ],

    setup(ctx): EditApi {
      // Two ways in, and both must work. `plugins: [editPlugin({ topological: true })]`
      // hands the options to *this closure* and leaves `ctx.options` undefined, because
      // the kernel only ever sees an already-constructed plugin. A preset's tuple form,
      // `[editPlugin, { topological: true }]`, does the opposite — the factory is called
      // with nothing and the options arrive on `ctx.options`, which is what lets a later
      // preset re-tune an earlier one. So: closure first, context wins.
      const supplied = (ctx.options ?? {}) as EditOptions
      const merged: EditOptions = { ...options, ...supplied }

      const resolved: ResolvedEditOptions = {
        topological: merged.topological ?? false,
        allowVertexDelete: merged.allowVertexDelete ?? true,
        minVertices: merged.minVertices,
        // 10 px: a fingertip on a tablet in the field, and small enough that two
        // vertices 2 m apart at zoom 18 are still individually grabbable.
        handleSize: merged.handleSize ?? 10,
      }

      ctx.disposables.add(ctx.i18n.register('en', en))
      ctx.disposables.add(ctx.i18n.register('tr', tr))

      const controller = new EditController(ctx, resolved)
      controller.handles.install()

      ctx.disposables.add(ctx.tools.register('edit:vertex', vertexTool(ctx, controller)))
      ctx.disposables.add(ctx.tools.register('edit:transform', transformTool(ctx, controller)))
      ctx.disposables.add(ctx.tools.register('edit:split', splitTool(ctx, controller)))
      ctx.disposables.add(ctx.tools.register('edit:merge', mergeTool(ctx, controller)))

      // Keep the handles honest when the geometry changes underneath us — an undo, a
      // server sync, another plugin's command. Without this, Ctrl-Z during an edit
      // leaves the handles hovering where the vertices used to be, and the next drag
      // grabs a corner that is no longer there.
      ctx.disposables.add(
        ctx.store.onChange((change) => {
          if (HANDLE_COLLECTIONS.has(change.collection)) return
          const editing = controller.editing
          if (editing === null) return
          if (!change.features.some((feature) => feature.id === editing)) return
          controller.refreshHandles()
        }),
      )

      return createApi(controller)
    },

    disable(ctx): void {
      // Dormant, not destroyed: the session ends and the handles go away, but the tools
      // stay registered and the options survive — re-enabling must not require the host
      // app to re-install anything.
      ctx.tryPlugin('edit')?.stop()
    },
  }
}

declare module '@blaeu/core' {
  interface BlaeuPluginRegistry {
    edit: EditApi
  }

  interface BlaeuEventMap {
    'edit:start': { readonly id: FeatureId; readonly feature: BlaeuFeature }
    'edit:vertex-move': {
      readonly id: FeatureId
      /** Every vertex that moved — more than one when a shared corner moved topologically. */
      readonly refs: readonly VertexRef[]
      readonly from: LngLat
      readonly to: LngLat
    }
    'edit:vertex-add': {
      readonly id: FeatureId
      readonly at: LngLat
      readonly refs: readonly VertexRef[]
    }
    'edit:vertex-delete': {
      readonly id: FeatureId
      readonly at: LngLat
      readonly refs: readonly VertexRef[]
    }
    /** `feature` is `undefined` when the session ended because the feature went away. */
    'edit:complete': { readonly id: FeatureId; readonly feature: BlaeuFeature | undefined }
    'edit:split': { readonly source: FeatureId; readonly parts: readonly BlaeuFeature[] }
    'edit:merge': { readonly sources: readonly FeatureId[]; readonly feature: BlaeuFeature }
    /** Cancellable: `preventDefault()` keeps the user in the edit session. */
    'before:edit:complete': { readonly id: FeatureId; readonly feature: BlaeuFeature | undefined }
  }
}
