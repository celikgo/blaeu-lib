import type {
  CollectionId,
  Command,
  CommandContext,
  FeatureInput,
  FlexiFeature,
} from '@fleximap/core'

/** One collection and the features that should be in it after the command runs. */
export type CollectionContent = readonly [
  collection: CollectionId,
  features: readonly FeatureInput[],
]

export interface ReplaceOptions {
  readonly label: string
  /** Transient commands execute but are never recorded in history. Default `true`. */
  readonly transient?: boolean
}

/**
 * Replaces the entire contents of one or more collections.
 *
 * This is how the rubber band is drawn, and it is a `Command` rather than a direct
 * store write for one reason: **nothing mutates the store directly** (core invariant
 * 2). It is `transient` by default, so a 300-pointermove gesture does not deposit
 * 300 entries in the undo stack — a rubber band is not a thing anyone wants to press
 * Ctrl-Z back through.
 *
 * `undo` still restores deep equality, and that is not busywork even for a transient
 * command: the same class is what re-derives the label layer when the locale changes,
 * and a transaction that throws mid-way rolls back through `store.restore()` — which
 * only works if the state it captured was complete. The contract holds or it doesn't;
 * there is no "mostly".
 */
export class ReplaceCollectionsCommand implements Command<void> {
  readonly type = 'measure:replace-collections'
  readonly label: string
  readonly transient: boolean

  readonly #entries: readonly CollectionContent[]
  /** What was in those collections before the first execution, with meta intact. */
  #previous: readonly FlexiFeature[] | undefined

  constructor(entries: readonly CollectionContent[], options: ReplaceOptions) {
    this.#entries = entries
    this.label = options.label
    this.transient = options.transient ?? true
  }

  execute(ctx: CommandContext): void {
    // Captured once. A redo must restore the state as it was before this command
    // *first* ran, not before it most recently ran — otherwise replaying the history
    // stack twice gives two different stores.
    if (this.#previous === undefined) {
      this.#previous = this.#entries.flatMap(([collection]) =>
        ctx.store.collection(collection).all(),
      )
    }

    this.#emptyTargets(ctx)
    for (const [collection, features] of this.#entries) {
      if (features.length > 0) ctx.store._add(collection, features)
    }
  }

  undo(ctx: CommandContext): void {
    this.#emptyTargets(ctx)
    if (this.#previous === undefined) return

    // Re-added by collection, carrying the meta the store stamped the first time —
    // same id, same version, same createdAt. That is what makes the round-trip *deep*
    // equality rather than "the same shape, one version higher".
    const byCollection = new Map<CollectionId, FlexiFeature[]>()
    for (const feature of this.#previous) {
      const group = byCollection.get(feature.meta.collection) ?? []
      group.push(feature)
      byCollection.set(feature.meta.collection, group)
    }
    for (const [collection, features] of byCollection) {
      ctx.store._add(collection, features)
    }
  }

  #emptyTargets(ctx: CommandContext): void {
    const ids = this.#entries.flatMap(([collection]) =>
      ctx.store
        .collection(collection)
        .all()
        .map((feature) => feature.id),
    )
    if (ids.length > 0) ctx.store._remove(ids)
  }
}
