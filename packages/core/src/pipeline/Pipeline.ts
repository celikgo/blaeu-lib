import type { Disposable } from '../types/common.js'
import type {
  CommitContext,
  CommitMiddleware,
  CommitPipeline,
  InteractionContext,
  InteractionMiddleware,
  InteractionPipeline,
  MiddlewareOptions,
} from '../types/pipeline.js'

interface Entry<M> {
  readonly id: string
  readonly priority: number
  readonly fn: M
}

let anonCounter = 0

function insert<M>(entries: Entry<M>[], fn: M, options: MiddlewareOptions): Entry<M> {
  const entry: Entry<M> = {
    id: options.id ?? `anon-${++anonCounter}`,
    priority: options.priority ?? 0,
    fn,
  }
  entries.push(entry)
  entries.sort((a, b) => b.priority - a.priority)
  return entry
}

/**
 * The synchronous interaction pipeline.
 *
 * Koa-style: each middleware receives the context and a `next` it may call, skip,
 * or call *around* its own work. The composability that buys is real — snapping
 * runs before the tool, but a "constrain to 45° increments" middleware can run
 * *after* snapping and override it, purely by registering at a lower priority.
 *
 * Sync by contract (core invariant 4). This runs on every `pointermove`, so an
 * `async` middleware here would add a frame of latency and reorder events under
 * load — the user sees it as the cursor lagging behind the snap indicator. The
 * type of {@link InteractionMiddleware} forbids it: `void`, not `Promise<void>`.
 */
export class SyncInteractionPipeline implements InteractionPipeline {
  #entries: Entry<InteractionMiddleware>[] = []

  use(middleware: InteractionMiddleware, options: MiddlewareOptions = {}): Disposable {
    const entry = insert(this.#entries, middleware, options)
    return {
      dispose: () => {
        const i = this.#entries.indexOf(entry)
        if (i >= 0) this.#entries.splice(i, 1)
      },
    }
  }

  remove(id: string): void {
    this.#entries = this.#entries.filter((e) => e.id !== id)
  }

  run(ctx: InteractionContext): InteractionContext {
    // Snapshot: a middleware may legitimately add or remove middleware (a tool
    // activating installs its constraint middleware), and mutating mid-walk would
    // skip an entry.
    const entries = [...this.#entries]
    let index = -1

    const dispatch = (i: number): void => {
      // Guards against a middleware calling `next()` twice, which would run the
      // rest of the chain a second time and — because middleware mutates
      // `ctx.lngLat` — double-apply the snap offset. Silent, and horrible to find.
      if (i <= index) {
        throw new Error('[fleximap] next() called multiple times in interaction middleware')
      }
      index = i
      const entry = entries[i]
      if (!entry) return
      entry.fn(ctx, () => dispatch(i + 1))
    }

    try {
      dispatch(0)
    } catch (err) {
      // A thrown middleware must not wedge the map. Report and let the tool see
      // the context as far as it got — a partly-processed pointer event is far
      // better than a dead cursor.
      console.error('[fleximap] interaction middleware threw:', err)
    }
    return ctx
  }

  list(): readonly { id: string; priority: number }[] {
    return this.#entries.map((e) => ({ id: e.id, priority: e.priority }))
  }

  /** @internal */
  clear(): void {
    this.#entries = []
  }

  /** @internal Teardown assertion. */
  get size(): number {
    return this.#entries.length
  }
}

/**
 * The asynchronous commit pipeline.
 *
 * Runs on every store mutation and may **veto** it. This is where validation,
 * attribute defaults, audit stamps and precision reduction live.
 *
 * Async, unlike its interaction sibling, because a genuine cadastral topology
 * check is a network call to a parcel registry. Blocking the main thread on that
 * would freeze the map; callers already `await` the dispatch, so the cost lands
 * where it is visible and cancellable.
 */
export class AsyncCommitPipeline implements CommitPipeline {
  #entries: Entry<CommitMiddleware>[] = []

  use(middleware: CommitMiddleware, options: MiddlewareOptions = {}): Disposable {
    const entry = insert(this.#entries, middleware, options)
    return {
      dispose: () => {
        const i = this.#entries.indexOf(entry)
        if (i >= 0) this.#entries.splice(i, 1)
      },
    }
  }

  remove(id: string): void {
    this.#entries = this.#entries.filter((e) => e.id !== id)
  }

  async run(ctx: CommitContext): Promise<CommitContext> {
    const entries = [...this.#entries]
    let index = -1

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) {
        throw new Error('[fleximap] next() called multiple times in commit middleware')
      }
      index = i
      // Short-circuit the moment anything vetoes. There is no point running an
      // expensive server-side topology check on a feature a cheap local rule has
      // already rejected — which is exactly why priority ordering puts the cheap
      // rules first.
      if (ctx.rejected) return
      const entry = entries[i]
      if (!entry) return
      await entry.fn(ctx, () => dispatch(i + 1))
    }

    try {
      await dispatch(0)
    } catch (err) {
      // A middleware that throws must not let a half-validated write through.
      // Failing closed is the only defensible default when the thing being
      // guarded is a land registry.
      console.error('[fleximap] commit middleware threw:', err)
      ctx.reject(err instanceof Error ? err.message : String(err))
    }
    return ctx
  }

  list(): readonly { id: string; priority: number }[] {
    return this.#entries.map((e) => ({ id: e.id, priority: e.priority }))
  }

  /** @internal */
  clear(): void {
    this.#entries = []
  }

  /** @internal Teardown assertion. */
  get size(): number {
    return this.#entries.length
  }
}
