/**
 * `@blaeu/plugin-draw` — point, line, polygon, rectangle, circle and freehand.
 *
 * What it registers: six tools (`draw:point` … `draw:freehand`), a collection for the
 * shape in progress (`draw:preview`), and — unless you turn it off — a theme-styled layer
 * that renders it (`previewLayer`, on by default).
 *
 * What it depends on: nothing, hard. `snap` and `history` are both optional and both
 * *enhance* rather than enable — see the degradation test in `draw.test.ts`.
 *
 * What it never does: import the snap plugin. The tools read `ctx.lngLat`, which the snap
 * middleware has already rewritten by the time a tool sees it. The one thing draw tells
 * snap is what is in flight (the ring's committed vertices, so the user can close it on its
 * own first corner) and what to ignore (the preview feature, so the rubber band cannot snap
 * to itself). Both go through a duck-typed handle — see `snap-handle.ts`.
 */

import type { CollectionId, FeatureInput, BlaeuFeature, BlaeuPlugin, LngLat } from '@blaeu/core'

import { PREVIEW_COLLECTION, PREVIEW_LAYER, previewLayerStyle } from './preview.js'
import { DrawSession } from './session.js'
import { circleTool } from './tools/circle.js'
import { freehandTool } from './tools/freehand.js'
import { lineTool } from './tools/line.js'
import { pointTool } from './tools/point.js'
import { polygonTool } from './tools/polygon.js'
import { rectangleTool } from './tools/rectangle.js'
import type { DrawTool } from './tools/tool.js'
import {
  DRAW_MODES,
  resolveOptions,
  type DrawApi,
  type DrawMode,
  type DrawOptions,
} from './types.js'

export type { DrawApi, DrawMode, DrawOptions } from './types.js'
export {
  DRAW_MODES,
  DEFAULT_CIRCLE_SEGMENTS,
  DEFAULT_COLLECTION,
  DEFAULT_FREEHAND_TOLERANCE_METRES,
} from './types.js'
export {
  PREVIEW_COLLECTION,
  PREVIEW_ID,
  PREVIEW_PROPERTY,
  PREVIEW_LAYER,
  previewLayerStyle,
} from './preview.js'
export {
  CIRCLE_CENTRE_PROPERTY,
  CIRCLE_RADIUS_PROPERTY,
  CIRCLE_SEGMENTS_PROPERTY,
  CIRCLE_SHAPE_PROPERTY,
  circleCentre,
  circlePolygon,
  rectanglePolygon,
} from './shapes.js'
export { douglasPeucker, simplifyTrace } from './simplify.js'

/**
 * Teaches the kernel about this plugin.
 *
 * After this, `map.plugin('draw')` is a `DrawApi` with no cast, and
 * `map.events.on('draw:complete', (e) => e.payload.feature)` type-checks — a typo in the
 * event name is a compile error rather than a listener that silently never fires.
 */
declare module '@blaeu/core' {
  interface BlaeuPluginRegistry {
    draw: DrawApi
  }

  interface BlaeuEventMap {
    'draw:start': { readonly mode: DrawMode }
    'draw:vertex': {
      readonly mode: DrawMode
      readonly vertex: LngLat
      readonly vertices: readonly LngLat[]
    }
    'draw:complete': {
      readonly mode: DrawMode
      readonly collection: CollectionId
      readonly feature: BlaeuFeature
    }
    'draw:cancel': { readonly mode: DrawMode; readonly reason: string | undefined }
    /**
     * Fires **before** the shape is dispatched, so a listener that calls `preventDefault()`
     * leaves nothing behind: no feature, no history entry, no half-written collection.
     *
     * The payload carries a `FeatureInput`, not a `BlaeuFeature` — at this point the store
     * has not minted an id or stamped a version, and pretending otherwise would hand
     * listeners a feature whose id no later event will ever mention again.
     */
    'before:draw:complete': {
      readonly mode: DrawMode
      readonly collection: CollectionId
      readonly feature: FeatureInput
    }
  }
}

export function drawPlugin(options: DrawOptions = {}): BlaeuPlugin<DrawApi, DrawOptions> {
  // Per-map state, keyed by context (see plugin-select). One plugin object installed on two maps
  // must not let the second map's `setup` clobber the first's session — otherwise disabling draw
  // on one map would cancel the other's in-progress shape.
  const sessions = new WeakMap<object, DrawSession>()

  return {
    id: 'draw',
    version: '1.0.0',

    // Both optional, and both genuinely so. Without `snap`, the tools read an unsnapped
    // pointer position and everything else is identical. Without `history`, the commands
    // still execute — nothing records them, which is exactly what a read-only viewer or a
    // kiosk wants.
    dependencies: [
      { id: 'snap', optional: true },
      { id: 'history', optional: true },
    ],

    setup(ctx): DrawApi {
      // A preset installing `[drawPlugin, { defaultMode: 'polygon' }]` never calls the
      // factory with arguments — its options arrive through `ctx.options`. A user calling
      // `drawPlugin({ ... })` passes them to the factory. Both must work, and the preset's
      // wins, because the preset is the later, more specific word.
      const resolved = resolveOptions({ ...options, ...(ctx.options ?? {}) })
      const active = new DrawSession(ctx, resolved)
      sessions.set(ctx, active)

      // Declared up front rather than on first use: the renderer creates a source per
      // collection, and a source that appears halfway through the first gesture appears
      // *above* the data layers, which is where the preview must not be.
      ctx.store.createCollection(PREVIEW_COLLECTION)
      // Disposed last (the store disposes in reverse), so the tools have already been
      // deactivated — and their previews cleared — by the time the collection goes.
      ctx.disposables.addFn(() => ctx.store.removeCollection(PREVIEW_COLLECTION))

      // Render the rubber band. Without this the preview is invisible unless the app
      // declares its own layer — which every preset forgot to, so drawing showed nothing
      // in progress. The style is a *function of the theme*, so the layer re-tints on a
      // theme change with no work here; an app that wants a different look sets
      // `previewLayer: false` and declares its own over PREVIEW_COLLECTION.
      if (resolved.previewLayer) {
        ctx.disposables.add(
          ctx.layers.add({
            id: PREVIEW_LAYER,
            type: 'vector',
            source: PREVIEW_COLLECTION,
            style: (tokens) => previewLayerStyle(tokens),
          }),
        )
        // The rubber band must sit above the data it is drawn over, but plugins install
        // before a preset's layers exist. `map:ready` fires after every declared layer is
        // added — the first moment "on top" means anything. (Installed at runtime, the
        // layer is already on top and this never fires.)
        ctx.disposables.add(ctx.events.on('map:ready', () => ctx.layers.move(PREVIEW_LAYER)))
      }

      const tools = new Map<DrawMode, DrawTool>()
      for (const mode of DRAW_MODES) {
        const tool = createTool(mode, active)
        tools.set(mode, tool)
        ctx.disposables.add(ctx.tools.register(tool.id, tool))
      }

      if (resolved.defaultMode !== null) ctx.tools.activate(`draw:${resolved.defaultMode}`)

      return {
        start(mode: DrawMode): void {
          if (!tools.has(mode)) {
            throw new Error(
              `[draw] unknown mode "${mode}". Known modes: [${DRAW_MODES.join(', ')}].`,
            )
          }
          ctx.tools.activate(`draw:${mode}`)
        },
        cancel(): void {
          active.cancel('cancelled by the application')
        },
        finish(): void {
          const mode = active.mode
          if (mode === null) return
          tools.get(mode)?.finish()
        },
        get active(): DrawMode | null {
          return active.mode
        },
        get vertices(): readonly LngLat[] {
          return active.vertices
        },
        setCollection(id: CollectionId): void {
          active.setCollection(id)
        },
      }
    },

    /**
     * Dormant, not gone: the tools stay registered, so a toolbar that lists them does not
     * flicker, but anything half-drawn is abandoned. Leaving a ring in progress on a
     * disabled plugin means the next `enable` resumes a gesture the user has long forgotten.
     */
    disable(ctx): void {
      const activeTool = ctx.tools.active
      if (activeTool !== null && activeTool.startsWith('draw:')) ctx.tools.deactivate()
      sessions.get(ctx)?.cancel('the draw plugin was disabled')
    },
  }
}

function createTool(mode: DrawMode, session: DrawSession): DrawTool {
  switch (mode) {
    case 'point':
      return pointTool(session)
    case 'line':
      return lineTool(session)
    case 'polygon':
      return polygonTool(session)
    case 'rectangle':
      return rectangleTool(session)
    case 'circle':
      return circleTool(session)
    case 'freehand':
      return freehandTool(session)
  }
}
