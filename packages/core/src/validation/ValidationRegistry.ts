import type { Disposable } from '../types/common.js'
import type { CrsService } from '../types/crs.js'
import type { EventBus } from '../types/events.js'
import type { BlaeuFeature } from '../types/feature.js'
import type { I18n } from '../types/i18n.js'
import type { CommitMiddleware, CommitPipeline } from '../types/pipeline.js'
import type { FeatureStore } from '../types/store.js'
import type {
  ValidationContext,
  ValidationIssue,
  ValidationRegistry,
  ValidationRule,
} from '../types/validation.js'

/**
 * Deliberately low, so validation runs **last**.
 *
 * The middleware that fills in attribute defaults, reduces coordinates to the CRS
 * grid, rewinds ring winding order and stamps `updatedAt` all sit above zero. If
 * validation ran before them it would judge geometry that is not what the store
 * ends up holding — and a rule that passes on the pre-quantised ring and fails on
 * the quantised one is a bug you find in production, in a land registry.
 */
const COMMIT_PRIORITY = -100

/**
 * The rule registry, and the one place validation is wired into the write path.
 *
 * Note what is *not* here: the store has no idea validation exists. It exposes a
 * commit pipeline, and validation is a middleware on it — which is why a preset
 * can block an edit made by a plugin written years later, and why a read-only
 * viewer that never registers a rule pays nothing for the machinery.
 */
export class BlaeuValidationRegistry implements ValidationRegistry {
  readonly #rules = new Map<string, ValidationRule>()
  readonly #ctx: ValidationContext

  constructor(store: FeatureStore, crs: CrsService, i18n: I18n) {
    // `t` is a closure over the i18n instance rather than a captured `i18n.t`, so a
    // rule authored years ago starts speaking Turkish the moment setLocale('tr')
    // runs — it never sees the locale, and never has to.
    this.#ctx = { store, crs, t: (key, params) => i18n.t(key, params) }
  }

  /**
   * Register a rule. **A later rule with the same id replaces the earlier one.**
   *
   * That is not laziness: presets *append* their rules (see the preset-authoring
   * skill), so a municipal preset composed on top of the national one re-adds
   * `parcel.minArea` with a bigger minimum and means to replace it. Running both
   * would reject every parcel between the two thresholds, with two contradictory
   * error messages.
   */
  add(rule: ValidationRule): Disposable {
    this.#rules.set(rule.id, rule)
    return {
      dispose: () => {
        // Remove only what this call added. If a later registration has already
        // replaced this rule, disposing the earlier one must not take the
        // replacement down with it.
        if (this.#rules.get(rule.id) === rule) this.#rules.delete(rule.id)
      },
    }
  }

  remove(id: string): void {
    this.#rules.delete(id)
  }

  list(): readonly ValidationRule[] {
    return [...this.#rules.values()]
  }

  async run(features: readonly BlaeuFeature[]): Promise<readonly ValidationIssue[]> {
    if (this.#rules.size === 0 || features.length === 0) return []

    // The batch is the same set being judged. A relational rule (overlap, gap) needs it
    // because validation runs before the store write, so a co-committed sibling is not yet
    // in the index — see `ValidationContext.pending`. Built once per run, shared by every
    // rule×feature check.
    const ctx: ValidationContext = { ...this.#ctx, pending: features }

    const issues: ValidationIssue[] = []
    const scheduled: Promise<readonly ValidationIssue[]>[] = []

    for (const rule of this.#rules.values()) {
      for (const feature of features) {
        let applies: boolean
        try {
          // The cheap pre-filter, run synchronously and *before* anything is
          // scheduled: a rule that doesn't apply to this feature must not cost a
          // projection, a promise, or a network call.
          applies = rule.appliesTo?.(feature) ?? true
        } catch (err) {
          issues.push(this.#threw(rule, feature, err))
          continue
        }
        if (!applies) continue
        scheduled.push(this.#check(rule, feature, ctx))
      }
    }

    // Parallel, because a real cadastral overlap check is a round-trip to a parcel
    // registry and running ten of them in series is ten times the latency for no
    // benefit. `#check` never rejects, so `Promise.all` cannot discard the issues
    // found by the rules that did complete.
    for (const result of await Promise.all(scheduled)) issues.push(...result)
    return issues
  }

  /**
   * Install the commit-pipeline middleware. Called once, by the kernel.
   *
   * This is the whole indirection: validation does not reach into the store, and
   * the store does not reach into validation. They meet on a middleware chain that
   * neither of them owns.
   */
  asCommitMiddleware(commit: CommitPipeline, events: EventBus): Disposable {
    const middleware: CommitMiddleware = async (ctx, next) => {
      // A removal takes geometry *out* of the store. Validating it would make an
      // already-invalid parcel impossible to delete — the exact opposite of what a
      // data steward cleaning up a bad import needs.
      if (ctx.operation === 'remove' || this.#rules.size === 0) {
        await next()
        return
      }

      const issues = await this.run(ctx.features)
      if (issues.length === 0) {
        await next()
        return
      }

      // Warnings ride along with the errors. A UI wants to say "sliver, 0.4 m²"
      // even when the write succeeds; if the event carried only errors, the only
      // way to ever see a warning would be to fail.
      events.emit('validation:failed', { issues })

      const errors = issues.filter((issue) => issue.severity === 'error')
      if (errors.length === 0) {
        await next()
        return
      }

      // Veto, and do not call next(). Invalid geometry must not exist in the store
      // even transiently — something always exports it.
      ctx.reject(this.#rejection(errors))
    }

    return commit.use(middleware, { id: 'core:validation', priority: COMMIT_PRIORITY })
  }

  async #check(
    rule: ValidationRule,
    feature: BlaeuFeature,
    ctx: ValidationContext,
  ): Promise<readonly ValidationIssue[]> {
    try {
      return await rule.check(feature, ctx)
    } catch (err) {
      return [this.#threw(rule, feature, err)]
    }
  }

  /**
   * A rule that throws has **not** said the feature is fine.
   *
   * Fail closed, always as an `error` regardless of the rule's declared severity,
   * and keep going with the other rules — a crashed check that silently passes is
   * how an invalid parcel reaches a title deed.
   */
  #threw(rule: ValidationRule, feature: BlaeuFeature, err: unknown): ValidationIssue {
    const error = err instanceof Error ? err.message : String(err)
    return {
      rule: rule.id,
      severity: 'error',
      message: this.#ctx.t('validation.ruleThrew', { rule: rule.id, error }),
      feature: feature.id,
      data: { error },
    }
  }

  #rejection(errors: readonly ValidationIssue[]): string {
    const summary = this.#ctx.t('validation.rejected', { count: errors.length })
    const detail = errors.map((issue) => `[${issue.rule}] ${issue.message}`).join(' | ')
    return `${summary} ${detail}`
  }
}
