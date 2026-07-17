import type {
  CollectionId,
  Command,
  CommandContext,
  Disposable,
  BlaeuPlugin,
  PluginContext,
  StoreSnapshot,
} from '@blaeu/core'

import { DEFAULT_ZONING_CATEGORIES, FIELD } from './zoning.js'
import type { ZoningCategory } from './types.js'

/* ------------------------------------------------------------------ *
 * Public shape
 * ------------------------------------------------------------------ */

/** A named store snapshot. Everything a scenario is. */
export interface Scenario {
  readonly name: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly snapshot: StoreSnapshot
}

/** How much of the plan one category takes up, in one scenario. */
export interface CategoryArea {
  readonly code: string
  readonly label: string
  /** m², planar in the working CRS. */
  readonly areaM2: number
}

export interface CategoryDelta {
  readonly code: string
  readonly label: string
  /** m² in scenario `a`. */
  readonly areaA: number
  /** m² in scenario `b`. */
  readonly areaB: number
  /** `areaB - areaA`. Positive means `b` allocated more of it. */
  readonly deltaM2: number
  /**
   * `deltaM2 / areaA`, as a percentage — or `null` when `a` had none of this
   * category.
   *
   * `null` rather than `Infinity` or `100`: a category that goes from nothing to
   * eight hectares has not grown by any percentage, it has *appeared*, and a report
   * that prints "+∞ %" or, worse, "+100 %" is one a planner will misread once and
   * distrust forever.
   */
  readonly deltaPercent: number | null
}

export interface ScenarioComparison {
  readonly a: string
  readonly b: string
  /** One row per category present in either scenario, plus the legend's, ordered by the legend. */
  readonly categories: readonly CategoryDelta[]
  readonly totalA: number
  readonly totalB: number
}

export interface ScenarioApi {
  /**
   * Snapshot the store under `name` and make it the active scenario.
   *
   * @throws if `name` is empty or already taken — silently overwriting somebody's
   *   afternoon of work is not a feature.
   */
  create(name: string): Scenario

  /**
   * Check the current work into the active scenario, then restore `name`.
   *
   * Goes through the command bus, so switching scenarios is **undoable** like
   * everything else (core invariant 2) — a planner who switches away mid-thought
   * gets back with Ctrl-Z rather than with a support ticket.
   *
   * @throws if `name` is unknown.
   */
  switch(name: string): void

  /** Re-snapshot the store into the active scenario, without switching. */
  save(): Scenario

  readonly active: string | null
  list(): readonly Scenario[]
  get(name: string): Scenario | undefined
  remove(name: string): void

  /** Per-category area delta, `b` relative to `a`. @throws if either name is unknown. */
  compare(a: string, b: string): ScenarioComparison

  /** Category areas within one scenario. */
  areas(name: string): readonly CategoryArea[]

  onChange(handler: (active: string | null) => void): Disposable
}

export interface ScenarioOptions {
  /** Collection the zoning polygons live in. Default `'zoning'`. */
  readonly collection?: CollectionId
  /** Property carrying the zoning code. Default `'zoning'`. */
  readonly property?: string
  /** The legend, so a comparison can name and order its rows. */
  readonly categories?: readonly ZoningCategory[]
}

declare module '@blaeu/core' {
  interface BlaeuPluginRegistry {
    scenario: ScenarioApi
  }

  interface BlaeuEventMap {
    /** Active scenario changed — including to `null`, when the active one was removed. */
    'scenario:changed': {
      readonly active: string | null
      readonly previous: string | null
    }
  }
}

/* ------------------------------------------------------------------ *
 * The command
 * ------------------------------------------------------------------ */

/**
 * Swap the whole store for a snapshot, and move the plugin's active pointer with it.
 *
 * A scenario switch is a mutation, so it is a `Command` — not a call to
 * `store.restore()` from a click handler. The payoff is concrete: undo works, the
 * renderer repaints from the diff `restore()` emits, and a history panel shows
 * "Senaryo: Yoğun" as one step instead of showing nothing at all while the map
 * silently changes underneath it.
 *
 * **It restores two things, not one: the store *and* the active-scenario pointer.**
 * The pointer is the plugin's own state, not the store's, so undoing the store restore
 * without moving the pointer back leaves `active` naming a scenario that is no longer
 * on the map — and the very next `switch()` calls `save()`, which then writes the
 * current plan into the *wrong* scenario, silently overwriting its baseline. Carrying
 * the pointer transition inside the command is what keeps undo/redo honest about which
 * scenario the map is showing.
 *
 * A restore is deliberately dispatched, not committed. It loads an already-validated
 * snapshot (every feature in it passed validation when it was edited), and a
 * whole-store swap is a mix of adds, updates and removes that a single `CommitIntent`
 * cannot express anyway. It is undoable, but it is not re-run through the commit
 * pipeline — see the error `switch()` throws.
 *
 * `undo` restores the snapshot taken *inside* `execute`. Since `FeatureStore.snapshot()`
 * derives its revision from the content, the round-trip is deep-equal, which is the
 * contract every command owes.
 */
class SwitchScenarioCommand implements Command {
  readonly type = 'urban:scenario-switch'
  readonly label: string

  readonly #target: StoreSnapshot
  readonly #toName: string
  readonly #fromName: string | null
  readonly #applyActive: (name: string | null) => void
  #before: StoreSnapshot | undefined

  constructor(
    target: StoreSnapshot,
    toName: string,
    fromName: string | null,
    label: string,
    applyActive: (name: string | null) => void,
  ) {
    this.#target = target
    this.#toName = toName
    this.#fromName = fromName
    this.#applyActive = applyActive
    this.label = label
  }

  execute(ctx: CommandContext): void {
    this.#before = ctx.store.snapshot()
    ctx.store.restore(this.#target)
    this.#applyActive(this.#toName)
  }

  undo(ctx: CommandContext): void {
    if (this.#before === undefined) return
    ctx.store.restore(this.#before)
    this.#applyActive(this.#fromName)
  }
}

/* ------------------------------------------------------------------ *
 * The plugin
 * ------------------------------------------------------------------ */

/**
 * Named scenarios, as a preset-local plugin.
 *
 * It lives in the preset package rather than in `packages/plugin-*` on purpose, and
 * the reason is the plugin/preset line itself: "compare two versions of the plan by
 * zoning category" is not a *capability* the kernel is missing — it is *judgement*
 * about what an urban planner does all day. Ship it where the domain is. A preset
 * shipping its own plugin is a supported shape, not a workaround; this is what it
 * looks like.
 *
 * Everything it does is built from two kernel primitives — `store.snapshot()` /
 * `store.restore()` and the command bus — and it needed no change to the core.
 */
export function scenarioPlugin(
  options: ScenarioOptions = {},
): BlaeuPlugin<ScenarioApi, ScenarioOptions> {
  return {
    id: 'scenario',
    version: '1.0.0',
    dependencies: [],

    setup(ctx: PluginContext<ScenarioOptions>): ScenarioApi {
      // Options arrive twice — through the factory (a preset's `[scenarioPlugin, opts]`
      // tuple is invoked with the *merged* options) and on `ctx.options` — and the
      // context wins, because that is the one a later preset retuned.
      const merged: ScenarioOptions = {
        ...options,
        ...(ctx.options as ScenarioOptions | undefined),
      }
      const collection: CollectionId = merged.collection ?? 'zoning'
      const property = merged.property ?? FIELD.zoning
      const categories = merged.categories ?? DEFAULT_ZONING_CATEGORIES

      const scenarios = new Map<string, Scenario>()
      const handlers = new Set<(active: string | null) => void>()
      let active: string | null = null

      const announce = (previous: string | null): void => {
        ctx.events.emit('scenario:changed', { active, previous })
        for (const handler of [...handlers]) {
          try {
            handler(active)
          } catch (err) {
            // One panel throwing must not stop the others being told.
            ctx.log.error('a scenario onChange handler threw', err)
          }
        }
      }

      /** Move the active pointer and tell everyone. The one place `active` is written. */
      const setActive = (name: string | null): void => {
        const previous = active
        active = name
        announce(previous)
      }

      const require_ = (name: string, verb: string): Scenario => {
        const scenario = scenarios.get(name)
        if (scenario === undefined) {
          const known = scenarios.size === 0 ? 'none yet' : [...scenarios.keys()].join(', ')
          throw new Error(
            `[blaeu] cannot ${verb} scenario "${name}": there is no such scenario. ` +
              `Known scenarios: ${known}. Create it first with map.plugin('scenario').create(name).`,
          )
        }
        return scenario
      }

      const snapshotNow = (name: string, createdAt: number): Scenario => ({
        name,
        createdAt,
        updatedAt: Date.now(),
        snapshot: ctx.store.snapshot(),
      })

      const create = (name: string): Scenario => {
        if (name.length === 0) {
          throw new Error('[blaeu] a scenario needs a non-empty name, e.g. create("Yoğun").')
        }
        if (scenarios.has(name)) {
          throw new Error(
            `[blaeu] scenario "${name}" already exists. ` +
              `Pick another name, or call save() to overwrite the active one deliberately.`,
          )
        }
        const scenario = snapshotNow(name, Date.now())
        scenarios.set(name, scenario)

        setActive(name)
        return scenario
      }

      const save = (): Scenario => {
        if (active === null) {
          throw new Error(
            '[blaeu] save() has no active scenario to save into. Call create(name) first.',
          )
        }
        const existing = require_(active, 'save')
        const scenario = snapshotNow(existing.name, existing.createdAt)
        scenarios.set(scenario.name, scenario)
        return scenario
      }

      const switchTo = (name: string): void => {
        const target = require_(name, 'switch to')
        if (name === active) return

        // Check the current work in before leaving. A scenario tool that loses the
        // last ten minutes because the planner clicked the wrong tab is a tool they
        // will never click again.
        if (active !== null) save()

        // The command carries the active-pointer transition, so undo/redo move it in
        // step with the store — `active` is set by execute (via setActive), not here.
        const result = ctx.commands.dispatch(
          new SwitchScenarioCommand(
            target.snapshot,
            name,
            active,
            ctx.i18n.t('urban.scenario.switch', { name }),
            setActive,
          ),
        )
        if (!result.ok) {
          throw new Error(
            `[blaeu] switching to scenario "${name}" was rejected: ` +
              `${result.rejectedReason ?? 'a before:command:execute listener vetoed it'}. ` +
              `The scenario is unchanged. A scenario restore loads an already-validated ` +
              `snapshot, so it rides the command bus for undo but is not re-run through the ` +
              `commit pipeline — only a before:command:execute listener can veto it, never a validation rule.`,
          )
        }
      }

      const areasOf = (snapshot: StoreSnapshot): Map<string, number> => {
        const byCode = new Map<string, number>()
        for (const feature of snapshot.collections[collection] ?? []) {
          const raw = feature.properties[property]
          const code = typeof raw === 'string' && raw.length > 0 ? raw : UNZONED
          // Planar, in the working CRS, in metres (core invariant 3). A spherical area
          // here would make every delta in the report wrong in the same direction, which
          // is the kind of wrong that survives review.
          byCode.set(code, (byCode.get(code) ?? 0) + ctx.crs.area(feature.geometry))
        }
        return byCode
      }

      /** Legend order first — a report a planner can read top-to-bottom — then any stragglers. */
      const codesIn = (...maps: readonly Map<string, number>[]): readonly string[] => {
        const ordered: string[] = categories.map((category) => category.code)
        const seen = new Set(ordered)
        for (const map of maps) {
          for (const code of map.keys()) {
            if (seen.has(code)) continue
            seen.add(code)
            ordered.push(code)
          }
        }
        return ordered
      }

      const labelOf = (code: string): string => {
        // `t()` returns the key itself when there is no translation — so the locale
        // wins when it has an opinion, the legend's own label is the fallback, and the
        // raw code is the fallback's fallback. An unknown code from a plan import still
        // names itself rather than rendering as an empty cell in the report.
        const key = `urban.zoning.${code}`
        const translated = ctx.i18n.t(key)
        if (translated !== key) return translated
        return categories.find((category) => category.code === code)?.label ?? code
      }

      const areas = (name: string): readonly CategoryArea[] => {
        const found = areasOf(require_(name, 'read areas from').snapshot)
        return codesIn(found).map((code) => ({
          code,
          label: labelOf(code),
          areaM2: found.get(code) ?? 0,
        }))
      }

      const compare = (a: string, b: string): ScenarioComparison => {
        const areasA = areasOf(require_(a, 'compare').snapshot)
        const areasB = areasOf(require_(b, 'compare').snapshot)

        const rows: CategoryDelta[] = codesIn(areasA, areasB).map((code) => {
          const areaA = areasA.get(code) ?? 0
          const areaB = areasB.get(code) ?? 0
          const deltaM2 = areaB - areaA
          return {
            code,
            label: labelOf(code),
            areaA,
            areaB,
            deltaM2,
            deltaPercent: areaA === 0 ? null : (deltaM2 / areaA) * 100,
          }
        })

        return {
          a,
          b,
          categories: rows,
          totalA: sum(areasA),
          totalB: sum(areasB),
        }
      }

      const remove = (name: string): void => {
        if (!scenarios.delete(name)) return
        if (active !== name) return
        setActive(null)
      }

      return {
        create,
        switch: switchTo,
        save,
        get active() {
          return active
        },
        list: () => [...scenarios.values()],
        get: (name) => scenarios.get(name),
        remove,
        compare,
        areas,
        onChange(handler) {
          handlers.add(handler)
          // Invariant 5: every subscription is a Disposable, and it goes in the store —
          // a host that forgets to dispose its own must not keep a dead map's panel alive.
          return ctx.disposables.add({ dispose: () => void handlers.delete(handler) })
        },
      }
    },
  }
}

/** The bucket for a polygon with no zoning code. It has an area; it needs a row. */
export const UNZONED = 'unzoned'

function sum(areas: ReadonlyMap<string, number>): number {
  let total = 0
  for (const area of areas.values()) total += area
  return total
}
