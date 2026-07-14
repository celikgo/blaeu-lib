/**
 * The four commands every product needs, and the reference implementation of the
 * `Command` contract for everyone writing the fifth.
 *
 * Each one obeys the rule that makes undo work across plugins that have never
 * heard of each other:
 *
 *   **`undo(execute(s))` restores `s` to deep equality.**
 *
 * The way they achieve it is worth copying. A command that captures *what it was
 * asked to do* can undo approximately. A command that captures *what the store
 * actually did* — the minted ids, the stamped meta, the features it really
 * removed — can undo exactly. These capture the second thing, in `execute`, and
 * replay it verbatim.
 */

import type { CollectionId, FeatureId } from '../types/common.js'
import type { CommandContext, CommitCommand, CommitIntent } from '../types/command.js'
import type { FeatureInput, FeatureProperties, FlexiFeature } from '../types/feature.js'
import type { Command } from '../types/command.js'

/** How long a gap in typing still counts as the same edit. Roughly one comfortable keystroke interval. */
const COALESCE_WINDOW_MS = 600

export interface CommandOptions {
  /** Already localised — it goes straight into the undo menu. */
  readonly label?: string
}

/**
 * Adds features to a collection.
 *
 * ```ts
 * const result = await map.commands.commit(
 *   new AddFeaturesCommand('parcels', [{ geometry, properties: { ada: '123' } }]),
 * )
 * const [parcel] = result.value ?? []
 * ```
 */
export class AddFeaturesCommand implements CommitCommand<readonly FlexiFeature[]> {
  readonly type = 'core:add-features'
  readonly label: string

  readonly #collection: CollectionId
  readonly #inputs: readonly FeatureInput[]
  /** What the commit pipeline approved — ids minted, meta stamped, geometry quantised. */
  #approved: readonly FlexiFeature[] | undefined
  /** What the store actually wrote. Replayed verbatim on redo. */
  #added: readonly FlexiFeature[] | undefined

  constructor(
    collection: CollectionId,
    features: readonly FeatureInput[],
    options: CommandOptions = {},
  ) {
    this.#collection = collection
    this.#inputs = features
    this.label = options.label ?? (features.length === 1 ? 'Add feature' : 'Add features')
  }

  intent(ctx: CommandContext): CommitIntent {
    // Materialise once and hold it. If we re-minted on every call, the ids the
    // pipeline validated would not be the ids the store went on to write, and a
    // rule that reported "parcel a1b2 overlaps" would be naming a feature that
    // never existed.
    this.#approved ??= this.#materialise(ctx, this.#inputs)
    return { operation: 'add', features: this.#approved, previous: [] }
  }

  adopt(features: readonly FlexiFeature[]): void {
    this.#approved = features
  }

  execute(ctx: CommandContext): readonly FlexiFeature[] {
    // Precedence, and it matters: what the store wrote (a redo — re-adding under
    // *new* ids would dangle every selection and label that referenced the old
    // ones), else what the pipeline approved, else the raw inputs.
    const writing = this.#added ?? this.#approved ?? this.#inputs

    const added: FlexiFeature[] = []
    for (const [collection, features] of this.#byCollection(writing)) {
      added.push(...ctx.store._add(collection, features))
    }

    this.#added = added
    return added
  }

  undo(ctx: CommandContext): void {
    if (this.#added === undefined) return
    ctx.store._remove(this.#added.map((f) => f.id))
  }

  #materialise(ctx: CommandContext, inputs: readonly FeatureInput[]): readonly FlexiFeature[] {
    const out: FlexiFeature[] = []
    for (const [collection, features] of this.#byCollection(inputs)) {
      out.push(...ctx.store.materialise(collection, features))
    }
    return out
  }

  /**
   * Route each feature to the collection it *asks* for, defaulting to the one this
   * command was constructed with.
   *
   * The default covers every ordinary case — `new AddFeaturesCommand('parcels', [...])`
   * means what it looks like. The override exists because commit middleware is allowed
   * to *add* features, and the ones it adds need not belong where the triggering
   * feature belongs: the game preset's `scatterAround` generator answers a hut placed
   * in `entities` with four trees destined for `decor`. Forcing those into `entities`
   * because that is what the command happened to name would put them on the wrong
   * layer, under the wrong style, in front of the wrong hit-test — and the generator
   * would have no way to say otherwise.
   */
  #byCollection(features: readonly FeatureInput[]): Map<CollectionId, FeatureInput[]> {
    const groups = new Map<CollectionId, FeatureInput[]>()
    for (const feature of features) {
      const collection = feature.meta?.collection ?? this.#collection
      const group = groups.get(collection)
      if (group === undefined) groups.set(collection, [feature])
      else group.push(feature)
    }
    return groups
  }
}

/**
 * Writes new versions of existing features. The general-purpose geometry edit —
 * a vertex move, a reshape, a merge — is one of these.
 */
export class UpdateFeaturesCommand implements CommitCommand<readonly FlexiFeature[]> {
  readonly type = 'core:update-features'
  readonly label: string

  #next: readonly FlexiFeature[]
  #previous: readonly FlexiFeature[] | undefined
  #written: readonly FlexiFeature[] | undefined

  constructor(features: readonly FlexiFeature[], options: CommandOptions = {}) {
    this.#next = features
    this.label = options.label ?? (features.length === 1 ? 'Update feature' : 'Update features')
  }

  intent(ctx: CommandContext): CommitIntent {
    this.#capture(ctx)
    return { operation: 'update', features: this.#next, previous: this.#previous ?? [] }
  }

  adopt(features: readonly FlexiFeature[]): void {
    this.#next = features
  }

  execute(ctx: CommandContext): readonly FlexiFeature[] {
    this.#capture(ctx)

    // Replaying `#written` on redo (rather than `#next`) reproduces the first
    // execution exactly — same version, same `updatedAt` — because the store takes
    // a meta it did not stamp itself verbatim.
    const written = ctx.store._update(this.#written ?? this.#next)
    this.#written = written
    return written
  }

  undo(ctx: CommandContext): void {
    if (this.#previous === undefined || this.#previous.length === 0) return
    ctx.store._update(this.#previous)
  }

  /**
   * Capture the pre-edit state, once.
   *
   * Called from both `intent` and `execute`, because a command may be committed
   * (pipeline first) or — for a transient preview — dispatched straight through,
   * and `#previous` must be identical either way.
   *
   * A redo must not re-capture: by then the store holds the *undone* state, which
   * is the same content — but the command's job is to restore the state as it was
   * before it ever ran, and re-deriving that from a store other commands may have
   * touched since is how undo stacks rot.
   */
  #capture(ctx: CommandContext): void {
    if (this.#previous !== undefined) return
    this.#previous = this.#next.map((feature) => {
      const prev = ctx.store.find(feature.id)
      if (prev === undefined) {
        throw new Error(
          `[fleximap] UpdateFeaturesCommand: feature "${feature.id}" is not in the store. ` +
            `Commit an AddFeaturesCommand first, or check that you are updating the id you think you are.`,
        )
      }
      return prev
    })
  }
}

/**
 * Removes features.
 *
 * `execute` captures the features the store *actually* removed — geometry, meta
 * and, crucially, which collection each came from. Undo then puts every one back
 * where it was: a selection can span collections, and returning a parcel to the
 * wrong one is silent data corruption that surfaces weeks later as "why is this
 * parcel styled like a building?".
 */
export class RemoveFeaturesCommand implements CommitCommand<readonly FlexiFeature[]> {
  readonly type = 'core:remove-features'
  readonly label: string

  readonly #ids: readonly FeatureId[]
  #removed: readonly FlexiFeature[] = []

  constructor(ids: readonly FeatureId[], options: CommandOptions = {}) {
    this.#ids = ids
    this.label = options.label ?? (ids.length === 1 ? 'Delete feature' : 'Delete features')
  }

  intent(ctx: CommandContext): CommitIntent {
    // Ids that aren't in the store are dropped rather than throwing: deleting a
    // selection that a collaborator already deleted is a no-op, not an error.
    const going = this.#ids.map((id) => ctx.store.find(id)).filter((f): f is FlexiFeature => !!f)
    return { operation: 'remove', features: going, previous: going }
  }

  /**
   * A no-op, and that is the correct behaviour rather than an omission.
   *
   * Middleware cannot rewrite a removal into something else — there is no feature
   * left to rewrite. Middleware can still *veto* one (a rule that refuses to delete
   * a parcel with a registered mortgage), and that veto works, because rejection is
   * enforced by the pipeline and not by this method.
   */
  adopt(): void {}

  execute(ctx: CommandContext): readonly FlexiFeature[] {
    this.#removed = ctx.store._remove(this.#ids)
    return this.#removed
  }

  undo(ctx: CommandContext): void {
    const byCollection = new Map<CollectionId, FlexiFeature[]>()
    for (const feature of this.#removed) {
      const group = byCollection.get(feature.meta.collection) ?? []
      group.push(feature)
      byCollection.set(feature.meta.collection, group)
    }
    for (const [collection, features] of byCollection) {
      // The captured features carry a complete meta, so the store re-adds them
      // verbatim: same id, same version, same createdAt. Deep equality, not
      // "near enough".
      ctx.store._add(collection, features)
    }
  }
}

/**
 * Merges a patch into features' `properties`.
 *
 * A key set to `undefined` is *removed* — which is what an attribute editor means
 * when the user clears a field, and it keeps the exported GeoJSON free of null
 * confetti.
 *
 * The interesting part is {@link coalesceWith}: without it, typing `Kadıköy` into
 * an attribute field produces seven undo entries and the user has to press Ctrl-Z
 * seven times to get their old value back. With it, the whole word is one step —
 * which is what every text field the user has ever used already does.
 */
export class SetPropertiesCommand implements CommitCommand<readonly FlexiFeature[]> {
  readonly type = 'core:set-properties'
  readonly label: string

  readonly ids: readonly FeatureId[]
  readonly patch: Readonly<FeatureProperties>

  readonly #window: number
  readonly #at: number = Date.now()
  #previous: readonly FlexiFeature[] | undefined
  #next: readonly FlexiFeature[] | undefined
  #written: readonly FlexiFeature[] | undefined

  constructor(
    ids: readonly FeatureId[],
    patch: Readonly<FeatureProperties>,
    options: CommandOptions & {
      /** Set to 0 to opt out of merging — e.g. for a one-shot "lock" toggle. */
      readonly coalesceWindowMs?: number
    } = {},
  ) {
    this.ids = ids
    this.patch = patch
    this.#window = options.coalesceWindowMs ?? COALESCE_WINDOW_MS
    this.label = options.label ?? 'Edit attributes'
  }

  intent(ctx: CommandContext): CommitIntent {
    this.#capture(ctx)
    return { operation: 'update', features: this.#next ?? [], previous: this.#previous ?? [] }
  }

  adopt(features: readonly FlexiFeature[]): void {
    this.#next = features
  }

  execute(ctx: CommandContext): readonly FlexiFeature[] {
    this.#capture(ctx)

    const written = ctx.store._update(this.#written ?? this.#next ?? [])
    this.#written = written
    return written
  }

  undo(ctx: CommandContext): void {
    if (this.#previous === undefined || this.#previous.length === 0) return
    ctx.store._update(this.#previous)
  }

  /** Read the current features and apply the patch. Once — see {@link UpdateFeaturesCommand}. */
  #capture(ctx: CommandContext): void {
    if (this.#previous !== undefined) return

    this.#previous = this.ids.map((id) => {
      const feature = ctx.store.find(id)
      if (feature === undefined) {
        throw new Error(
          `[fleximap] SetPropertiesCommand: feature "${id}" is not in the store. ` +
            `It may have been deleted while the attribute panel was still open — re-read the selection.`,
        )
      }
      return feature
    })

    this.#next = this.#previous.map((feature) => ({
      ...feature,
      properties: applyPatch(feature.properties, this.patch),
    }))
  }

  /**
   * Merges this edit into the one before it, if they are the same gesture: the same
   * features, the same fields, within the coalesce window.
   *
   * The merged command inherits `previous` from the *earlier* command — so undoing
   * it walks all the way back to the value before the first keystroke — and `written`
   * from the *later* one, so redoing it lands on the final text.
   *
   * Same fields is a deliberate condition. Tabbing from "ada" to "parsel" and typing
   * again is two edits to a user, and merging them would make one Ctrl-Z wipe a field
   * they had finished with.
   */
  coalesceWith(previous: Command): Command | null {
    if (!(previous instanceof SetPropertiesCommand)) return null
    if (this.#window <= 0 || previous.#window <= 0) return null
    if (this.#at - previous.#at > this.#window) return null
    if (!sameMembers(this.ids, previous.ids)) return null
    if (!sameMembers(Object.keys(this.patch), Object.keys(previous.patch))) return null

    const merged = new SetPropertiesCommand(
      this.ids,
      { ...previous.patch, ...this.patch },
      { label: this.label, coalesceWindowMs: this.#window },
    )
    merged.#previous = previous.#previous
    merged.#written = this.#written
    return merged
  }
}

function applyPatch(
  properties: FeatureProperties,
  patch: Readonly<FeatureProperties>,
): FeatureProperties {
  const next: FeatureProperties = { ...properties }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((item) => set.has(item))
}
