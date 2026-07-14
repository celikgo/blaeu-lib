import type { CollectionId, FlexiPlugin, LayerInstance } from '@fleximap/core'

import { LAYER_IDS, measureLayers, styleFor } from './layers.js'
import type { MeasureEnv } from './measurement.js'
import { en, tr } from './messages.js'
import { MeasureSession, measureTools } from './session.js'
import {
  DRAFT_COLLECTION,
  DRAFT_LABEL_COLLECTION,
  LABEL_COLLECTION,
  MEASURE_COLLECTION,
  TOOL_IDS,
  type MeasureApi,
  type MeasureMode,
  type MeasureOptions,
  type Measurement,
  type ResolvedMeasureOptions,
} from './types.js'

/** Everything the plugin owns in the store. Created on setup, dropped on destroy. */
const COLLECTIONS: readonly CollectionId[] = [
  MEASURE_COLLECTION,
  LABEL_COLLECTION,
  DRAFT_COLLECTION,
  DRAFT_LABEL_COLLECTION,
]

/**
 * Distance, area and grid bearing — planar, in the working CRS, in metres.
 *
 * ```ts
 * const map = await createFlexiMap({
 *   container: '#map',
 *   config: { crs: { working: 'EPSG:5254' } },   // TUREF / TM30. The plane the numbers live on.
 *   plugins: [snapPlugin(), measurePlugin({ areaUnit: 'donum' })],
 * })
 * map.plugin('measure').start('area')            // typed, no cast
 * ```
 *
 * Registers three tools (`measure:distance`, `measure:area`, `measure:bearing`), four
 * store collections, four layers, and two message bundles. Depends on nothing —
 * snapping is optional and, notably, is not *called*: it rewrites the pointer position
 * in interaction middleware long before a measure tool reads it.
 */
export function measurePlugin(
  options: MeasureOptions = {},
): FlexiPlugin<MeasureApi, MeasureOptions> {
  const resolved = resolveOptions(options)
  let session: MeasureSession | undefined

  return {
    id: 'measure',
    version: '1.0.0',
    dependencies: [
      // Optional, and it *degrades*: without snapping you measure exactly where you
      // clicked, which is what an un-snapped map should do. There is a test for that,
      // because an optional dependency with no degradation test is a required
      // dependency with a bug.
      { id: 'snap', optional: true },
    ],

    setup(ctx): MeasureApi {
      const env: MeasureEnv = { crs: ctx.crs, i18n: ctx.i18n, options: resolved }
      const current = new MeasureSession(ctx, env)
      session = current

      ctx.disposables.add(ctx.i18n.register('en', en))
      ctx.disposables.add(ctx.i18n.register('tr', tr))

      // Declared up front so the layers below have a source to bind to, and so that a
      // host app can style or reorder them before a single measurement exists.
      for (const collection of COLLECTIONS) ctx.store.createCollection(collection)

      const layers: LayerInstance[] = []
      for (const spec of measureLayers(ctx.theme)) {
        // The handle is itself a Disposable that removes the layer, so registering it
        // is all the teardown this needs (core invariant 5).
        layers.push(ctx.disposables.add(ctx.layers.add(spec)))
      }

      ctx.disposables.add(
        ctx.theme.onChange(() => {
          for (const layer of layers) layer.setStyle(styleFor(layer.id, ctx.theme))
        }),
      )

      // The label *text* is baked into the features, so a locale change is a redraw of
      // the label layer, not a restyle of it.
      ctx.disposables.add(ctx.i18n.onChange(() => current.relabel()))

      for (const [id, tool] of measureTools(current)) {
        ctx.disposables.add(ctx.tools.register(id, tool))
      }

      return {
        start(mode: MeasureMode): void {
          ctx.tools.activate(TOOL_IDS[mode])
        },
        clear(): Promise<void> {
          return current.clear()
        },
        get measurements(): readonly Measurement[] {
          return current.measurements
        },
        measureFeature(id: string): Measurement {
          return current.measureFeature(id)
        },
      }
    },

    /**
     * Dormant, not gone. The half-drawn shape is dropped (it belongs to a gesture that
     * is now over), and the tool is switched off — but every completed measurement
     * stays on the map, because a user toggling the panel shut and open again expects
     * to find their numbers still there.
     */
    disable(ctx): void {
      session?.cancel()
      const active = ctx.tools.active
      if (active !== null && Object.values(TOOL_IDS).includes(active)) ctx.tools.deactivate()
    },

    destroy(ctx): void {
      // `ctx.disposables` takes the layers, the tools, the listeners and the message
      // bundles. What it cannot take is the *data*: collections are not disposables, and
      // leaving four of them behind — full of measurement geometry nothing will ever
      // render again — is exactly the kind of leak the teardown test exists to catch.
      session?.cancel()
      session = undefined
      for (const collection of COLLECTIONS) ctx.store.removeCollection(collection)
    },
  }
}

function resolveOptions(options: MeasureOptions): ResolvedMeasureOptions {
  if (options.planar === false) {
    throw new Error(
      `[measure] planar: false is not supported. Every number this plugin reports is planar, in the ` +
        `working CRS, in metres — because spherical area on a 2 000 m² parcel at 39°N is wrong by square ` +
        `metres, and that is enough to move a boundary in a dispute. If the working CRS distorts your ` +
        `extent, set a better one (map.crs.setWorking('EPSG:5254') for Türkiye's 30°E belt); if you genuinely ` +
        `want great-circle distances, compute them yourself with turf and do not call them survey measurements.`,
    )
  }

  return {
    areaUnit: options.areaUnit ?? 'm2',
    lengthUnit: options.lengthUnit ?? 'm',
    planar: true,
    persist: options.persist ?? true,
  }
}

export { LAYER_IDS }
