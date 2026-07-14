import type { Disposable, FeatureId, LngLat } from './common.js'
import type { FlexiFeature } from './feature.js'
import type { CrsService } from './crs.js'
import type { FeatureStore } from './store.js'

export type Severity = 'error' | 'warning' | 'info'

export interface ValidationIssue {
  readonly rule: string
  readonly severity: Severity
  /** Already localised — rules receive the `t()` function and are expected to use it. */
  readonly message: string
  readonly feature: FeatureId
  /** Where the problem is. Drives "zoom to issue" in a UI. */
  readonly at?: LngLat
  /** Structured detail for programmatic handling, e.g. `{ overlapArea: 2.31 }`. */
  readonly data?: Record<string, unknown>
}

export interface ValidationContext {
  readonly store: FeatureStore
  readonly crs: CrsService
  /** Localise. Rules must not hardcode English. */
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

/**
 * A validation rule.
 *
 * Rules run in the **commit pipeline**, which means an `error` blocks the write
 * — the parcel is never stored, the command reports `{ ok: false }`, and undo has
 * nothing to undo. That's the correct behaviour for a land registry: invalid
 * geometry should not exist even transiently, because something will export it.
 *
 * Rules are the main thing a *preset* contributes. The topology plugin knows how
 * to detect an overlap; only the cadastre preset knows that an overlap is an
 * error while a gap is merely a warning.
 *
 * May be async — a real cadastral check may ask a server whether the neighbouring
 * parcel is under dispute.
 */
export interface ValidationRule {
  readonly id: string
  readonly severity: Severity
  /** Skip features this rule doesn't apply to — cheaply, before doing any geometry. */
  appliesTo?(feature: FlexiFeature): boolean
  check(
    feature: FlexiFeature,
    ctx: ValidationContext,
  ): readonly ValidationIssue[] | Promise<readonly ValidationIssue[]>
}

export interface ValidationRegistry {
  add(rule: ValidationRule): Disposable
  remove(id: string): void
  list(): readonly ValidationRule[]

  /**
   * Run every applicable rule.
   *
   * Called automatically by the commit pipeline, but also exposed so a UI can
   * offer "validate the whole layer" — which is how a surveyor checks a batch
   * import before committing to it.
   */
  run(features: readonly FlexiFeature[]): Promise<readonly ValidationIssue[]>
}
