import type { Disposable, FeatureId, BlaeuFeature, BlaeuPlugin } from '@blaeu/core'
import { resolveSelectOptions } from './options.js'
import { SelectionController } from './SelectionController.js'
import { BOX_TOOL, boxTool, LASSO_TOOL, lassoTool, SINGLE_TOOL, singleTool } from './tools.js'

export type { MultiKey, SelectOptions } from './options.js'
export type { SelectMode } from './SelectionController.js'
export { SINGLE_TOOL, BOX_TOOL, LASSO_TOOL } from './tools.js'
export { HIGHLIGHT_LAYER, PREVIEW_LAYER } from './overlay.js'

import type { SelectOptions } from './options.js'
import type { SelectMode } from './SelectionController.js'

export interface SelectApi {
  /**
   * Change the selection.
   *
   * - `replace` (default) — the set becomes exactly these ids
   * - `add` — union
   * - `toggle` — flip each id
   * - `subtract` — difference
   *
   * Ids that are not selectable (hidden, locked without `selectLocked`, outside the
   * configured collections, or not in the store) are dropped. `subtract` is exempt:
   * a feature locked *after* it was selected must still be removable.
   */
  select(ids: FeatureId | readonly FeatureId[], mode?: SelectMode): void

  clear(): void

  readonly selected: ReadonlySet<FeatureId>

  /** The selected features, resolved live from the store. */
  readonly features: readonly BlaeuFeature[]

  /** Select everything matching a predicate. Handy for "select all parcels in this ada". */
  selectByFilter(fn: (feature: BlaeuFeature) => boolean): void

  /** Fires on every change. **Dispose it** — see core invariant 5. */
  onChange(handler: (ids: ReadonlySet<FeatureId>) => void): Disposable
}

declare module '@blaeu/core' {
  interface BlaeuPluginRegistry {
    select: SelectApi
  }

  interface BlaeuEventMap {
    /**
     * The deltas, not just the set.
     *
     * A UI that only got `selected` would have to diff it against its own copy to
     * know which table row to un-highlight — and would get it wrong the first time
     * two selections changed within one frame.
     */
    'select:changed': {
      readonly selected: ReadonlySet<FeatureId>
      readonly added: readonly FeatureId[]
      readonly removed: readonly FeatureId[]
    }
  }
}

/**
 * Selection: single click, multi-select, box drag, freehand lasso.
 *
 * Registers three tools (`select:single`, `select:box`, `select:lasso`), two
 * renderer layers for the highlight and the marquee, and nothing else. It declares
 * no dependencies: selection is the one thing every other plugin wants to build on,
 * so it must work on a bare kernel.
 */
export function selectPlugin(options: SelectOptions = {}): BlaeuPlugin<SelectApi, SelectOptions> {
  /*
   * Keyed by context, not held in a plain variable, because one plugin object may
   * legitimately be installed on two maps (`const p = selectPlugin(); mapA.use(p);
   * mapB.use(p)`), and a shared controller would then have map A's selection
   * highlighting map B's parcels. The manager hands `setup`, `enable` and `disable`
   * the *same* context object per installation, so it is the right key — and a
   * WeakMap means a destroyed map's controller is collectable.
   */
  const controllers = new WeakMap<object, SelectionController>()

  return {
    id: 'select',
    version: '1.0.0',

    setup(ctx): SelectApi {
      // `ctx.options` is only populated for the tuple install form
      // (`plugins: [[selectPlugin, { multiKey: 'ctrl' }]]`), where a preset can retune
      // the plugin without re-invoking the factory. The factory argument is what the
      // direct form (`plugins: [selectPlugin({ … })]`) carries. Merge both, so the two
      // spellings mean the same thing.
      const resolved = resolveSelectOptions({ ...options, ...(ctx.options ?? {}) })
      const controller = new SelectionController(ctx, resolved)
      controllers.set(ctx, controller)
      ctx.disposables.add(controller)
      ctx.disposables.addFn(() => controllers.delete(ctx))

      ctx.disposables.add(ctx.tools.register(SINGLE_TOOL, singleTool(controller)))
      ctx.disposables.add(ctx.tools.register(BOX_TOOL, boxTool(ctx, controller)))
      ctx.disposables.add(ctx.tools.register(LASSO_TOOL, lassoTool(ctx, controller)))

      return {
        select: (ids, mode) => controller.select(ids, mode),
        clear: () => controller.clear(),
        get selected() {
          return controller.selected
        },
        get features() {
          return controller.features
        },
        selectByFilter: (fn) => controller.selectByFilter(fn),
        onChange: (handler) => controller.onChange(handler),
        // The API is a facade over the controller rather than the controller itself:
        // handing out the object would hand out `dispose()`, and a UI that calls it
        // tears down the plugin from the outside with nothing to put it back.
      }
    },

    enable(ctx): void {
      controllers.get(ctx)?.overlay.setVisible(true)
    },

    /**
     * Dormant, not gone (see the `BlaeuPlugin` contract): the selection set survives a
     * disable, so a user who toggles the selection tool off and back on again finds the
     * twelve parcels they had picked still picked.
     */
    disable(ctx): void {
      const active = ctx.tools.active
      if (active === SINGLE_TOOL || active === BOX_TOOL || active === LASSO_TOOL) {
        ctx.tools.deactivate()
      }
      controllers.get(ctx)?.overlay.setVisible(false)
    },
  }
}
