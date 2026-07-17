/**
 * `@blaeu/plugin-topology` — topology validation for people whose job is to be
 * exactly right.
 *
 * The plugin owns the *engine*: JSTS, run in the projected working CRS, over
 * candidate neighbours pulled from the spatial index. The `ValidationRule`s it
 * ships are exported individually, because a rule's severity is a **domain**
 * decision and only a preset knows the domain (see `./rules.ts`).
 */

import {
  UpdateFeaturesCommand,
  type Disposable,
  type FeatureId,
  type BlaeuFeature,
  type BlaeuPlugin,
  type PluginContext,
  type ValidationContext,
  type ValidationIssue,
  type ValidationRule,
} from '@blaeu/core'

import { isFixable, repair } from './fix.js'
import { en, tr } from './messages.js'
import {
  closedRings,
  noDuplicateVertices,
  noGapsWithNeighbours,
  noOverlapWithNeighbours,
  noSelfIntersection,
  noSlivers,
  DEFAULT_SLIVER_RATIO,
  DEFAULT_TOLERANCE_METRES,
  STRUCTURAL_RULE_IDS,
  TOPOLOGY_RULE_PREFIX,
} from './rules.js'

/* ------------------------------------------------------------------ *
 * Public shape
 * ------------------------------------------------------------------ */

export interface TopologyOptions {
  /**
   * Apply the repairable fixes automatically after every `validate()`.
   *
   * **Defaults to `false`, and that default is a product decision, not a
   * conservative guess.** Silently "correcting" a boundary is how software loses
   * the trust of the people whose job it is to be exactly right — and it loses it
   * permanently, because once a surveyor has found one parcel they did not move,
   * they must re-check every parcel they did not move. Even the repairs we *can*
   * make are lossy: `buffer(0)` on a self-intersecting ring changes the parcel's
   * area, and the area is the number on the deed.
   *
   * The software reports. The surveyor decides. Turn this on only for machine-
   * generated data that no human has signed.
   */
  readonly autoFix?: boolean

  /** perimeter²/area above which a polygon is a sliver. See {@link DEFAULT_SLIVER_RATIO}. */
  readonly sliverRatio?: number

  /** Metres. The precision below which two coordinates are the same corner. Default 1 mm. */
  readonly tolerance?: number
}

export interface TopologyApi {
  /**
   * Run every registered topology rule over `ids` — or over the whole store when
   * called with nothing, which is how a surveyor checks a batch import before
   * committing to it.
   */
  validate(ids?: readonly FeatureId[]): Promise<readonly ValidationIssue[]>

  /** The issues from the last `validate()`. Empty until one has run. */
  readonly issues: readonly ValidationIssue[]

  /**
   * Repair one issue. **Explicit, never automatic** (unless `autoFix`).
   *
   * Returns `false` — and changes nothing — when the defect has no honest repair:
   * an overlap, a gap, a sliver and an undersized parcel are all *decisions*, and
   * this library does not get to make them. The repair goes through the command
   * bus, so it undoes like anything else.
   */
  fix(issue: ValidationIssue): Promise<boolean>

  onIssues(handler: (issues: readonly ValidationIssue[]) => void): Disposable
}

declare module '@blaeu/core' {
  interface BlaeuPluginRegistry {
    topology: TopologyApi
  }

  interface BlaeuEventMap {
    /** Emitted by every `validate()`, including the ones that find nothing — a UI needs to clear its panel. */
    'topology:issues': { readonly issues: readonly ValidationIssue[] }
  }
}

/* ------------------------------------------------------------------ *
 * The plugin
 * ------------------------------------------------------------------ */

export function topologyPlugin(
  options: TopologyOptions = {},
): BlaeuPlugin<TopologyApi, TopologyOptions> {
  const autoFix = options.autoFix ?? false
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_METRES
  const sliverRatio = options.sliverRatio ?? DEFAULT_SLIVER_RATIO

  return {
    id: 'topology',
    version: '1.0.0',
    // No dependencies at all, optional or otherwise. Topology needs the store, the
    // spatial index and the CRS — all of which are kernel, not plugin.
    dependencies: [],

    setup(ctx: PluginContext<TopologyOptions>): TopologyApi {
      ctx.disposables.add(ctx.i18n.register('en', en))
      ctx.disposables.add(ctx.i18n.register('tr', tr))

      registerDefaultRules(ctx, { tolerance, sliverRatio })

      // A `ValidationContext` is what a rule expects, and the kernel only ever builds
      // one inside its own registry. Building ours here is what lets `validate()` run
      // a *subset* of the rules — the topology ones — with the fail-fast ordering the
      // registry's flat `run()` cannot express.
      const validationCtx: ValidationContext = {
        store: ctx.store,
        crs: ctx.crs,
        t: (key, params) => ctx.i18n.t(key, params),
      }

      let issues: readonly ValidationIssue[] = []
      const handlers = new Set<(issues: readonly ValidationIssue[]) => void>()

      const publish = (next: readonly ValidationIssue[]): void => {
        issues = next
        ctx.events.emit('topology:issues', { issues: next })
        for (const handler of [...handlers]) {
          try {
            handler(next)
          } catch (err) {
            // One misbehaving panel must not stop the others from being told.
            ctx.log.error('an onIssues handler threw', err)
          }
        }
      }

      const collect = (ids: readonly FeatureId[] | undefined): readonly BlaeuFeature[] => {
        if (ids === undefined) return allFeatures(ctx)
        const found: BlaeuFeature[] = []
        for (const id of ids) {
          const feature = ctx.store.find(id)
          if (feature === undefined) {
            ctx.log.warn(`validate(): feature "${id}" is not in the store; skipping it.`)
            continue
          }
          found.push(feature)
        }
        return found
      }

      const run = async (features: readonly BlaeuFeature[]): Promise<ValidationIssue[]> => {
        const rules = ctx.validation.list().filter((r) => r.id.startsWith(TOPOLOGY_RULE_PREFIX))
        const structural = rules.filter((r) => STRUCTURAL_RULE_IDS.has(r.id))
        const heavy = rules.filter((r) => !STRUCTURAL_RULE_IDS.has(r.id))

        const found: ValidationIssue[] = []
        for (const feature of features) {
          const cheap = await checkAll(structural, feature, validationCtx)
          found.push(...cheap)

          // Fail fast. An unclosed ring or a duplicate vertex makes every downstream
          // JSTS answer either a crash or a lie, and the crash's stack trace blames the
          // overlay operation rather than the import that produced the ring.
          if (cheap.some((issue) => issue.severity === 'error')) continue

          found.push(...(await checkAll(heavy, feature, validationCtx)))
        }
        return found
      }

      const fix = async (issue: ValidationIssue): Promise<boolean> => {
        const feature = ctx.store.find(issue.feature)
        if (feature === undefined) return false

        const geometry = repair(feature.geometry, issue.rule, ctx.crs.working, tolerance)
        if (geometry === undefined) {
          ctx.log.info(ctx.i18n.t('topology.fix.unavailable', { rule: issue.rule }))
          return false
        }

        // Through the command bus, so the repair lands in the undo stack next to the
        // surveyor's own edits — a "fix" you cannot take back is not a fix, it is damage.
        //
        // And through `commit`, so the repaired geometry is re-validated on its way in.
        // A repair that silently introduced a *different* violation — snapping a sliver
        // closed and in doing so pushing a vertex across a neighbour's boundary — would
        // otherwise be written without anything checking it, which is precisely the
        // failure mode that makes surveyors distrust automatic fixes.
        const result = await ctx.commands.commit(
          new UpdateFeaturesCommand([{ ...feature, geometry }], {
            label: ctx.i18n.t('topology.fix.applied', { feature: feature.id, rule: issue.rule }),
          }),
        )
        if (!result.ok) {
          ctx.log.warn(`fix() was rejected: ${result.rejectedReason ?? 'unknown reason'}`)
          return false
        }

        // Drop every issue this repair addressed, rather than the one object handed in:
        // a UI that round-trips issues through JSON hands back an equal object, not an
        // identical one, and identity matching would leave the list stale forever.
        publish(issues.filter((i) => !(i.rule === issue.rule && i.feature === issue.feature)))
        return true
      }

      const validate = async (ids?: readonly FeatureId[]): Promise<readonly ValidationIssue[]> => {
        let found = await run(collect(ids))

        if (autoFix) {
          // Sequential, and awaited. `.filter(fix)` would be the natural way to write
          // this and it would be silently wrong now that `fix` is async: every element
          // would survive the filter, because a Promise is truthy — so `repaired` would
          // be non-empty even when nothing was repairable, and the "did anything change?"
          // question below would always answer yes.
          //
          // Sequential rather than `Promise.all` because two repairs can touch the same
          // shared corner, and the second must see what the first wrote.
          let repaired = 0
          for (const issue of found.filter((i) => isFixable(i.rule))) {
            if (await fix(issue)) repaired++
          }

          // Re-derive rather than subtract: repairing a self-intersection changes the
          // geometry, so every overlap and sliver answer computed from the old one is
          // now unfounded. One extra pass, never a loop — a repair that keeps producing
          // issues is a bug we want visible, not one we want to grind against.
          if (repaired > 0) found = await run(collect(ids))
        }

        publish(found)
        return found
      }

      return {
        validate,
        get issues() {
          return issues
        },
        fix,
        onIssues(handler) {
          handlers.add(handler)
          // Registered in ctx.disposables too (core invariant 5): a host that forgets to
          // dispose its own subscription must not keep a destroyed map's panel alive.
          return ctx.disposables.add({ dispose: () => void handlers.delete(handler) })
        },
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

interface RuleDefaults {
  readonly tolerance: number
  readonly sliverRatio: number
}

/**
 * Registers the built-in rule set — **without stomping on a preset's**.
 *
 * The registry replaces by id, and plugins are installed *after* a preset's rules
 * are registered. So a plugin that blindly re-added `topology.overlap` would
 * silently overwrite a preset that had deliberately set it to `warning` for a
 * jurisdiction where overlaps are adjudicated rather than rejected. Whoever spoke
 * first, and more specifically, wins.
 */
function registerDefaultRules(ctx: PluginContext<TopologyOptions>, defaults: RuleDefaults): void {
  const existing = new Set(ctx.validation.list().map((rule) => rule.id))

  const rules: readonly ValidationRule[] = [
    // Structural first, so they are also first in the registry's iteration order.
    closedRings(),
    noDuplicateVertices({ tolerance: defaults.tolerance }),
    noSelfIntersection(),
    noOverlapWithNeighbours({ tolerance: defaults.tolerance }),
    noGapsWithNeighbours({ tolerance: defaults.tolerance }),
    noSlivers({ sliverRatio: defaults.sliverRatio }),
    // `minParcelArea` is deliberately absent: its only honest value is the legal
    // minimum in a particular jurisdiction, and this plugin does not know one. A
    // preset adds it.
  ]

  for (const rule of rules) {
    if (existing.has(rule.id)) {
      ctx.log.debug(`rule "${rule.id}" is already registered; leaving the existing one in place.`)
      continue
    }
    ctx.disposables.add(ctx.validation.add(rule))
  }
}

function allFeatures(ctx: PluginContext<TopologyOptions>): readonly BlaeuFeature[] {
  const features: BlaeuFeature[] = []
  for (const id of ctx.store.collections()) {
    features.push(...ctx.store.collection(id).all())
  }
  return features
}

async function checkAll(
  rules: readonly ValidationRule[],
  feature: BlaeuFeature,
  ctx: ValidationContext,
): Promise<readonly ValidationIssue[]> {
  const results = await Promise.all(rules.map((rule) => checkOne(rule, feature, ctx)))
  return results.flat()
}

/**
 * A rule that throws has **not** said the feature is fine.
 *
 * Fail closed, as an `error` regardless of the rule's declared severity, and keep
 * going with the other rules. A crashed check that silently passes is how an
 * invalid parcel reaches a title deed.
 */
async function checkOne(
  rule: ValidationRule,
  feature: BlaeuFeature,
  ctx: ValidationContext,
): Promise<readonly ValidationIssue[]> {
  try {
    if (rule.appliesTo?.(feature) === false) return []
    return await rule.check(feature, ctx)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return [
      {
        rule: rule.id,
        severity: 'error',
        message: ctx.t('validation.ruleThrew', { rule: rule.id, error }),
        feature: feature.id,
        data: { error },
      },
    ]
  }
}

/* ------------------------------------------------------------------ *
 * Barrel
 * ------------------------------------------------------------------ */

export {
  closedRings,
  minParcelArea,
  noDuplicateVertices,
  noGapsWithNeighbours,
  noOverlapWithNeighbours,
  noSelfIntersection,
  noSlivers,
  DEFAULT_GAP_SEARCH_METRES,
  DEFAULT_MAX_GAP_AREA_M2,
  DEFAULT_MAX_GAP_WIDTH_METRES,
  DEFAULT_MIN_AREA_M2,
  DEFAULT_SLIVER_RATIO,
  DEFAULT_TOLERANCE_METRES,
  RULE_IDS,
  STRUCTURAL_RULE_IDS,
  TOPOLOGY_RULE_PREFIX,
} from './rules.js'

export type {
  GapRuleOptions,
  MinAreaRuleOptions,
  RuleOptions,
  SliverRuleOptions,
  ToleranceRuleOptions,
} from './rules.js'

export { isFixable, FIXABLE_RULE_IDS } from './fix.js'
export { en, tr, topologyMessages } from './messages.js'
