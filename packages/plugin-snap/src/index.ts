import type { BlaeuPlugin, PluginContext, SnapResult } from '@blaeu/core'
import { resolveOptions, SnapEngine } from './engine.js'
import { snapMessagesEn, snapMessagesTr } from './messages.js'
import type { SnapApi, SnapOptions } from './types.js'

export type { SnapApi, SnapOptions } from './types.js'
export type { SnapDeps, SnapScope } from './geometry.js'
export {
  createScope,
  candidateAt,
  candidateAtLngLat,
  footOnLine,
  footOnSegment,
  segmentIntersection,
  segmentsNear,
  segmentsWhoseLineIsNear,
  eachPath,
  FrameCache,
} from './geometry.js'
export {
  createVertexProvider,
  createIntersectionProvider,
  createMidpointProvider,
  createEdgeProvider,
  createExtensionProvider,
  createPerpendicularProvider,
  createGridProvider,
} from './providers/index.js'
export {
  PRIORITY,
  BUILTIN_KINDS,
  DEFAULT_TOLERANCE_PX,
  INDICATOR_LAYER,
  INDICATOR_SOURCE,
} from './constants.js'

/**
 * Snapping, as interaction middleware.
 *
 * ```ts
 * const map = await createBlaeuMap({
 *   container: '#map',
 *   plugins: [snapPlugin({ tolerance: 12, gridSize: 5 }), drawPlugin()],
 * })
 *
 * map.events.on('snap:changed', (e) => status.textContent = e.payload.result?.candidate.hint ?? '')
 * ```
 *
 * The draw plugin above has never heard of this one, and that is the point. Snapping
 * registers a single middleware at priority 100; on every pointer event it queries
 * its providers, picks a winner, and **rewrites `ctx.lngLat`** before the pipeline
 * reaches any tool. The draw tool then reads a position that is already exactly on
 * the parcel corner — as does the measure tool, the edit tool, and a tool a stranger
 * writes next year.
 *
 * Hold **Alt** to suppress it for one event, as every CAD package on earth does.
 */
export function snapPlugin(options: SnapOptions = {}): BlaeuPlugin<SnapApi, SnapOptions> {
  // Bound to this plugin *instance*, which is bound to one map: `snapPlugin()` is
  // called once per installation, by the user or by `normalisePluginSpec`.
  let engine: SnapEngine | undefined

  return {
    id: 'snap',
    version: '1.0.0',

    /**
     * Anyone may `provide` snapping. A product that wants its own engine — snapping
     * to a server-side corner registry, say — implements this capability and every
     * plugin declaring `dependencies: [{ id: 'snap-engine', optional: true }]` is
     * satisfied by it without knowing that anything changed.
     */
    provides: ['snap-engine'],

    setup(ctx: PluginContext<SnapOptions>): SnapApi {
      // Options arrive twice — through the factory (the `[snapPlugin, opts]` tuple
      // form invokes it with them) and through `ctx.options`. Merging rather than
      // picking one is what makes both spellings work.
      const merged: SnapOptions = { ...options, ...(ctx.options as SnapOptions | undefined) }

      ctx.disposables.add(ctx.i18n.register('en', snapMessagesEn))
      ctx.disposables.add(ctx.i18n.register('tr', snapMessagesTr))

      engine = new SnapEngine(ctx, resolveOptions(merged))
      engine.install()
      return engine.api
    },

    /** Also called once, immediately after `setup` — so it must restore state, not force it on. */
    enable(): void {
      engine?.wake()
    },

    /** Dormant, not destroyed: providers, tolerance and exclusions survive a toggle. */
    disable(): void {
      engine?.sleep()
    },

    destroy(): void {
      // `ctx.disposables` takes the middleware, the layer, the source and the message
      // bundles. Only the reference is ours to drop.
      engine = undefined
    },
  }
}

declare module '@blaeu/core' {
  interface BlaeuPluginRegistry {
    snap: SnapApi
  }

  interface BlaeuEventMap {
    /**
     * The snap target changed — including to `undefined`, when the pointer leaves
     * everything snappable. Fires at most once per pointer event, and only when the
     * result actually *changed*: a status bar bound to this does not repaint 120
     * times a second while the cursor sits still on a corner.
     */
    'snap:changed': { readonly result: SnapResult | undefined }
  }
}
