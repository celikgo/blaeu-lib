/**
 * The **commit gate**: how a write reaches the store in a validated product.
 *
 * BlaeuMap has two pipelines, and they are different on purpose (core invariant 4):
 *
 * - The **interaction** pipeline is synchronous. It runs at pointer frequency and
 *   rewrites `ctx.lngLat` — that is where snapping lives, and it is why the draw tool
 *   has never heard of the snap plugin.
 * - The **commit** pipeline is asynchronous. It runs on the way *into* the store, and
 *   it may veto. It is async because a real cadastral check may ask a server whether
 *   the neighbouring parcel is under dispute — and blocking the main thread on that
 *   would freeze the map.
 *
 * The cadastre preset puts two things in the commit pipeline:
 *
 * 1. `deriveAreaMiddleware` — stamps `yuzolcumu` from the geometry, in the projected
 *    working CRS, on every write. This is why the area is never typed.
 * 2. the validation registry — every rule (self-intersection, overlap, gap, sliver,
 *    missing ada/parsel) runs here, and an `error` **rejects the write**. Invalid
 *    geometry must not exist in the store even transiently, because something always
 *    exports it.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * ⚠ **DX friction, stated plainly** — the kernel does not itself route
 * `commands.dispatch()` through the commit pipeline. `BlaeuCommandBus.dispatch` is
 * synchronous and the pipeline is async, so nothing in `packages/core` calls
 * `commit.run()`. That means a preset's commit middleware — including its validation
 * rules and its derived area — only runs if the *application* runs it. So this file
 * runs it, once, in one place, and everything that writes goes through here.
 *
 * That is a real seam a host app has to know about, and `preset-game` works around it
 * the same way (see `entity.ts`). The right fix lives in the kernel: an async
 * `commands.commit(command)` that walks the pipeline and then dispatches. Until then,
 * this module *is* the pattern — and it is short, which is the consolation.
 * ────────────────────────────────────────────────────────────────────────────────
 */

import {
  AddFeaturesCommand,
  createId,
  type CollectionId,
  type Command,
  type CommandContext,
  type CommitContext,
  type FeatureProperties,
  type BlaeuFeature,
  type BlaeuMap,
  type Geometry,
} from '@blaeu/core'

/* ========================================================================= */
/* Running the pipeline                                                      */
/* ========================================================================= */

/** Build the context the commit middleware expects. */
function createCommitContext(
  operation: CommitContext['operation'],
  features: readonly BlaeuFeature[],
  previous: readonly BlaeuFeature[],
): CommitContext {
  let rejected = false
  let reason: string | undefined

  return {
    operation,
    // Mutable on purpose: middleware *rewrites* what is about to be written. The
    // derive-area middleware replaces each parcel with a copy carrying a fresh
    // `yuzolcumu`, and whatever survives to the end of the pipeline is what lands.
    features: [...features],
    previous,
    command: undefined,
    reject(next: string): void {
      // First reason wins — it is the one closest to the cause.
      if (rejected) return
      rejected = true
      reason = next
    },
    get rejected(): boolean {
      return rejected
    },
    get rejectReason(): string | undefined {
      return reason
    },
  }
}

/**
 * Give the store the shape it will eventually hold, *before* the pipeline sees it.
 *
 * The pipeline works on `BlaeuFeature`s (it has to: a validation rule reports on
 * `feature.id`, and a rule that cannot name the parcel it rejected is useless in an
 * issue list). So the id and the meta are minted here rather than by the store. The
 * store honours both — `_add` takes a supplied id and meta verbatim — so the feature
 * the surveyor was told about is the feature that exists.
 */
export function draft(
  collection: CollectionId,
  geometry: Geometry,
  properties: FeatureProperties,
  id: string = createId(),
): BlaeuFeature {
  const now = Date.now()
  return {
    id,
    geometry,
    properties,
    meta: { collection, version: 1, createdAt: now, updatedAt: now, source: 'example' },
  }
}

export interface CommitResult {
  readonly ok: boolean
  /** Already localised — the validation registry hands back the rule's own Turkish message. */
  readonly reason: string | undefined
  readonly features: readonly BlaeuFeature[]
}

/**
 * Add features, but only if every rule says yes.
 *
 * On rejection nothing is dispatched: no feature, no history entry, nothing for the
 * user to undo. The `validation:failed` event has already fired by then, carrying the
 * issues — which is how the built-in issue panel fills itself without this function
 * telling it anything.
 */
export async function commitAdd(
  map: BlaeuMap,
  collection: CollectionId,
  features: readonly BlaeuFeature[],
  label: string,
): Promise<CommitResult> {
  const ctx = createCommitContext('add', features, [])
  await map.commit.run(ctx)

  if (ctx.rejected) {
    return { ok: false, reason: ctx.rejectReason, features: [] }
  }

  const written: BlaeuFeature[] = []
  // One transaction: however many parcels this was, the surveyor did one thing, so
  // Ctrl+Z undoes one thing.
  const result = map.commands.transaction(label, () => {
    const dispatched = map.commands.dispatch(
      new AddFeaturesCommand(collection, ctx.features, { label }),
    )
    if (!dispatched.ok) throw new Error(dispatched.rejectedReason ?? 'komut reddedildi')
    written.push(...(dispatched.value ?? []))
  })

  if (!result.ok) return { ok: false, reason: result.rejectedReason, features: [] }
  return { ok: true, reason: undefined, features: written }
}

/**
 * Re-run the pipeline over features that have *already* changed, and write back
 * whatever it derived.
 *
 * This exists because of the same gap as above, seen from the other side. When the
 * edit plugin moves a shared corner it dispatches its own `MoveVerticesCommand`
 * straight to the bus — correctly; it is a geometry edit — and the commit pipeline
 * never sees it. So after a drag the geometry is new and `yuzolcumu` is stale, which
 * for a *derived* field is the one thing that must never happen.
 *
 * We therefore re-derive and stamp. Two details are load-bearing:
 *
 * - The stamp is **transient**: it executes but is not recorded in history. It is not
 *   a user action, it is a projection of one — and the move command's own `undo()`
 *   restores the whole previous feature (geometry *and* properties), so one Ctrl+Z
 *   still puts everything back exactly. A recorded stamp would mean the first Ctrl+Z
 *   appeared to do nothing, which users rightly hate.
 * - It is a no-op when the number has not moved, so this cannot loop: the write it
 *   would emit is the write it is reacting to.
 *
 * @returns the issues-bearing reject reason, if a rule now objects to the edited
 *          geometry. The write has already happened by then — post-hoc, all we can do
 *          is say so loudly and let the surveyor press Ctrl+Z.
 */
export async function reconcile(
  map: BlaeuMap,
  features: readonly BlaeuFeature[],
): Promise<string | undefined> {
  if (features.length === 0) return undefined

  const ctx = createCommitContext('update', features, features)
  await map.commit.run(ctx)

  const changed = ctx.features.filter((next) => {
    const current = map.store.find(next.id)
    return current !== undefined && !sameProperties(current.properties, next.properties)
  })

  if (changed.length > 0) map.commands.dispatch(new StampDerivedCommand(changed))

  return ctx.rejected ? ctx.rejectReason : undefined
}

function sameProperties(a: FeatureProperties, b: FeatureProperties): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

/**
 * Writes derived properties back, without appearing in the undo stack.
 *
 * A small, complete `Command` — worth reading if you have never written one. It obeys
 * the contract that makes undo work across plugins that have never heard of each
 * other: `undo(execute(s))` restores `s` to **deep equality**, and it achieves that by
 * capturing what the store actually held rather than what it was asked to do.
 */
class StampDerivedCommand implements Command<void> {
  readonly type = 'cadastre:stamp-derived'
  readonly label = 'Yüzölçümü güncellendi'
  /** Ephemeral by the letter of the contract: it would be maddening to Ctrl+Z past this. */
  readonly transient = true

  readonly #next: readonly BlaeuFeature[]
  #previous: readonly BlaeuFeature[] | undefined

  constructor(features: readonly BlaeuFeature[]) {
    this.#next = features
  }

  execute(ctx: CommandContext): void {
    this.#previous ??= this.#next
      .map((feature) => ctx.store.find(feature.id))
      .filter((feature): feature is BlaeuFeature => feature !== undefined)
    ctx.store._update(this.#next)
  }

  undo(ctx: CommandContext): void {
    if (this.#previous !== undefined) ctx.store._update(this.#previous)
  }
}
