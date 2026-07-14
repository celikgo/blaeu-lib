import type { Disposable, FeatureId, LngLat, ProjectedXY, ScreenPoint } from './common.js'
import type { FlexiFeature } from './feature.js'
import type { Command } from './command.js'
import type { SnapResult } from './extensions.js'

/** Where a middleware sits relative to its peers. */
export interface MiddlewareOptions {
  /** Stable id, so it can be replaced or removed by name. */
  readonly id?: string
  /** Higher runs first. Default 0. Snapping sits at 100; grid-lock at 90. */
  readonly priority?: number
}

/* ------------------------------------------------------------------------- */
/* Interaction pipeline — synchronous, hot path                              */
/* ------------------------------------------------------------------------- */

/**
 * A normalised pointer/keyboard event, already unified across mouse, touch and
 * pen. Tools never see a raw DOM event, which is what makes a tool written for
 * the mouse work on a tablet in the field without changes.
 */
export interface InteractionContext {
  readonly kind: 'pointerdown' | 'pointermove' | 'pointerup' | 'click' | 'dblclick' | 'keydown'

  /**
   * The geographic position of the pointer — **mutable**, and that is the whole
   * point.
   *
   * Middleware rewrites this on the way through. By the time a tool reads it, it
   * has already been snapped to a parcel corner, locked to a grid, or constrained
   * to an orthogonal axis, depending on what the preset installed. The tool
   * doesn't know and doesn't need to.
   */
  lngLat: LngLat

  /** The same position in the working CRS. Kept in sync by the pipeline. */
  readonly xy: ProjectedXY

  /** Untouched screen position. Middleware must not rewrite this — it's the ground truth. */
  readonly screen: ScreenPoint

  /** The original, *unmodified* geographic position, before any middleware ran. */
  readonly rawLngLat: LngLat

  /** Set by the snapping middleware, read by UI middleware that draws the indicator. */
  snap?: SnapResult | undefined

  /**
   * The features the active tool is dragging right now — its own geometry, its handles,
   * its guides. Empty between gestures.
   *
   * **Middleware must not use these as targets.** A snapping middleware that offers the
   * dragged vertex its own current position pins it there forever: the pointer is pulled
   * back onto the corner it is trying to move, the tool computes "it didn't move", and
   * every drag shorter than the snap tolerance becomes a silent no-op.
   *
   * The tool declares this through `tools.setDragging()`. It does not, and must not, know
   * which middleware is reading it.
   */
  readonly dragging: readonly FeatureId[]

  readonly button: number
  readonly modifiers: {
    readonly shift: boolean
    readonly ctrl: boolean
    readonly alt: boolean
    readonly meta: boolean
  }
  /** Present only for `keydown`. */
  readonly key?: string

  /** Features under the cursor, lazily hit-tested — the getter is the cheap part. */
  hits(): readonly FlexiFeature[]

  /** Prevents the active tool from receiving this event at all. */
  consume(): void
  readonly consumed: boolean

  readonly originalEvent: Event
}

/**
 * Synchronous by contract.
 *
 * This runs on every `pointermove` — up to 120 Hz. An async middleware here adds
 * a frame of latency and reorders events under load, which the user perceives as
 * the cursor lagging behind the snap indicator. The return type forbids it: `void`,
 * not `Promise<void>`.
 *
 * If a middleware genuinely needs async work, it must do it speculatively off the
 * pipeline and cache the result — which is exactly what the snap engine does when
 * it rebuilds its spatial index on `camera:idle` rather than on `pointermove`.
 */
export type InteractionMiddleware = (ctx: InteractionContext, next: () => void) => void

export interface InteractionPipeline {
  use(middleware: InteractionMiddleware, options?: MiddlewareOptions): Disposable
  remove(id: string): void
  run(ctx: InteractionContext): InteractionContext
  list(): readonly { id: string; priority: number }[]
}

/* ------------------------------------------------------------------------- */
/* Commit pipeline — asynchronous, may veto                                  */
/* ------------------------------------------------------------------------- */

/** What is about to happen to the store, and why. */
export interface CommitContext {
  readonly operation: 'add' | 'update' | 'remove'

  /**
   * The features about to be written — **mutable**.
   *
   * Middleware may rewrite them: stamp `updatedAt`, fill in a default zoning
   * code, reduce coordinate precision to the CRS's grid, rewind ring winding
   * order. Whatever survives to the end of the pipeline is what lands in the
   * store.
   */
  features: FlexiFeature[]

  /** The previous state, for `update`/`remove`. Empty for `add`. */
  readonly previous: readonly FlexiFeature[]

  /** The command that triggered this, if any. Absent for direct loads/imports. */
  readonly command: Command | undefined

  /** Veto the write. The dispatch returns `{ ok: false, rejectedReason: reason }`. */
  reject(reason: string): void
  readonly rejected: boolean
  readonly rejectReason: string | undefined
}

/**
 * Asynchronous, because a genuine topology check calls a server — and blocking
 * the main thread on that would freeze the map. Callers already `await` the
 * dispatch, so the cost is paid where it's visible.
 */
export type CommitMiddleware = (ctx: CommitContext, next: () => Promise<void>) => Promise<void>

export interface CommitPipeline {
  use(middleware: CommitMiddleware, options?: MiddlewareOptions): Disposable
  remove(id: string): void
  run(ctx: CommitContext): Promise<CommitContext>
  list(): readonly { id: string; priority: number }[]
}
