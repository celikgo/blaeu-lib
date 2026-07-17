import type { Disposable } from './common.js'
import type { FeatureStore } from './store.js'
import type { EventBus } from './events.js'
import type { BlaeuFeature } from './feature.js'

/** What a command is allowed to touch when it runs. */
export interface CommandContext {
  readonly store: FeatureStore
  readonly events: EventBus
}

/**
 * A reversible mutation. **The only way anything in BlaeuMap changes state.**
 *
 * This is the single most important interface in the library, and the reason
 * undo/redo works *across plugins that have never heard of each other*: the
 * history plugin doesn't know what a "move vertex" is, it only knows that
 * something dispatched a `Command` and that `Command`s can be undone. A plugin
 * written years later, by a stranger, gets undo for free by implementing this.
 *
 * The contract is strict and worth stating plainly:
 *
 *   **`undo(execute(s))` must restore `s` to deep equality.**
 *
 * Not "close enough", not "visually identical". If your `undo` can't restore
 * deep equality, the command captured too little state — capture more. Every
 * command owes the round-trip test from the `blaeu-testing` skill.
 */
export interface Command<R = void> {
  /** Namespaced identifier, e.g. `draw:add-feature`. Used in history UIs and telemetry. */
  readonly type: string

  /**
   * Human-readable, already localised. Shown in the undo menu ("Undo Move
   * vertex") and in a history panel, so it should name the *user's* action, not
   * the implementation's.
   */
  readonly label?: string

  /**
   * A transient command executes but is never recorded in history.
   *
   * Use for genuinely ephemeral state — a hover highlight, a preview of the shape
   * being drawn. If it would be maddening to have to press Ctrl-Z past it, it is
   * transient.
   */
  readonly transient?: boolean

  execute(ctx: CommandContext): R

  undo(ctx: CommandContext): void

  /** Defaults to `execute`. Override only when redo genuinely differs (rare). */
  redo?(ctx: CommandContext): R

  /**
   * Identifies the user gesture this command belongs to — one pointer-down to the
   * matching pointer-up. Every frame of one vertex drag carries the same id.
   *
   * A gesture is **not** a stopwatch, and this field is what lets history know the
   * difference. History's `coalesceWindowMs` is a heuristic for commands that cannot
   * say what they belong to (keystrokes in a text field: "did the user pause?" is the
   * only question available). A command that *can* say — a drag, a transform — has
   * already answered it exactly, and must not be second-guessed by a wall clock: a
   * surveyor who drags a shared corner, pauses 400 ms to read the coordinate, then
   * nudges it home is making **one** gesture, and owes exactly one Ctrl-Z.
   *
   * Commands that declare it still get the final say through {@link coalesceWith} —
   * this only decides whether history *asks*.
   */
  readonly gesture?: string | undefined

  /**
   * Merge this command into the immediately-preceding one, if they're part of
   * the same logical gesture.
   *
   * Without this, dragging a vertex 200 pixels produces 200 undo entries and the
   * user has to press Ctrl-Z 200 times to get back. With it, one drag is one undo
   * step — which is what every user already assumes.
   *
   * @returns the merged command, or `null` to keep them separate.
   */
  coalesceWith?(previous: Command): Command | null
}

/**
 * What a command is about to do to the store, declared *before* it does it.
 *
 * This is the hinge the commit pipeline turns on. A `Command` is opaque — the
 * kernel cannot look inside `execute()` and work out that it is about to write
 * three parcels. So a command that touches features says so, up front, and hands
 * the pipeline the exact features that will land: real ids, geometry already
 * normalised and quantised. Middleware inspects them, may rewrite them, and may
 * refuse them — and only then does the command run.
 */
export interface CommitIntent {
  readonly operation: 'add' | 'update' | 'remove'

  /**
   * The features about to be written, exactly as the store will hold them. For a
   * `remove`, the features about to go.
   *
   * These are *materialised, not written*: ids are minted, meta is stamped, rings
   * are wound and coordinates snapped to the CRS grid. That matters, because a
   * validation rule that measures a parcel's area must measure the geometry that
   * will actually exist, not the raw input that has not been through the store's
   * normalisation yet. A rule that passes on the input and fails on the stored
   * feature is worse than no rule at all.
   */
  readonly features: readonly BlaeuFeature[]

  /** The state being replaced. Empty for `add`. */
  readonly previous: readonly BlaeuFeature[]
}

/**
 * A command that writes features, and can therefore be vetoed.
 *
 * Implement this — instead of the bare {@link Command} — whenever your command
 * adds, updates or removes features, and dispatch it with
 * {@link CommandBus.commit} rather than {@link CommandBus.dispatch}. Doing so is
 * what subjects it to the commit pipeline: the preset's derived fields get
 * stamped, and the product's validation rules get their veto.
 *
 * The reason this is an *opt-in interface* rather than something the kernel infers
 * is that not every store write should be validated. A drag preview, a vertex
 * handle, a snap indicator — these are transient UI scaffolding that lives in the
 * store because that is where the renderer reads from, and running a JSTS topology
 * check on them at 120 Hz would be both slow and wrong (geometry is *legitimately*
 * invalid halfway through a drag). Those stay on the synchronous `dispatch()` path.
 * The rule of thumb: **if it survives the gesture, it commits.**
 */
export interface CommitCommand<R = void> extends Command<R> {
  /**
   * Declare the write. Called by {@link CommandBus.commit} before `execute`, with
   * the store in the state the command will run against — so `previous` can be
   * read straight out of it.
   */
  intent(ctx: CommandContext): CommitIntent

  /**
   * Take the features the pipeline produced, and write *these* in `execute`.
   *
   * Middleware is allowed to rewrite `ctx.features` — that is how a preset stamps
   * a derived area, defaults a zoning code, or rewinds a ring. Whatever survives
   * the chain is handed back here, and it is what must land in the store. A command
   * that ignores this and writes its original inputs anyway has silently opted out
   * of every middleware in the product.
   */
  adopt(features: readonly BlaeuFeature[]): void
}

/** Narrowing guard. A command is committable iff it declares an intent. */
export function isCommitCommand<R>(command: Command<R>): command is CommitCommand<R> {
  const candidate = command as Partial<CommitCommand<R>>
  return typeof candidate.intent === 'function' && typeof candidate.adopt === 'function'
}

/** Result of dispatching. */
export interface DispatchResult<R> {
  readonly ok: boolean
  readonly value: R | undefined
  /** Set when a `before:command:execute` hook or a commit-pipeline middleware vetoed it. */
  readonly rejectedReason: string | undefined
}

/**
 * Dispatches commands and broadcasts what happened.
 *
 * Note what it does *not* do: it holds no undo stack. History is a plugin that
 * subscribes to `onDidExecute`. That keeps the kernel small and means a product
 * that genuinely doesn't want undo (a read-only viewer, a kiosk) doesn't pay for
 * it — and a product that wants *server-backed* collaborative undo can replace
 * the history plugin without touching the core.
 */
export interface CommandBus {
  /**
   * Run a command synchronously, without the commit pipeline.
   *
   * For commands that do **not** write durable features: a preview, a hover
   * highlight, a set of vertex handles, a tool-state change. This is the hot path
   * — it runs on `pointermove` — and it is synchronous for the same reason the
   * interaction pipeline is.
   *
   * A {@link CommitCommand} is rejected here *at compile time* (`intent?: never`
   * below is what does it, and the runtime throws too, for JavaScript callers).
   * That is deliberate and it is the whole point: if the way to skip validation
   * were "call the other method", then skipping validation would be a typo away,
   * and every product would eventually ship a write path that no rule guards.
   * Use {@link commit}.
   */
  dispatch<R>(command: Command<R> & { intent?: never }): DispatchResult<R>

  /**
   * Run a feature-writing command **through the commit pipeline**.
   *
   * This is where a preset's judgement and a product's rules actually get applied:
   * middleware stamps derived fields (a cadastral `yüzölçümü` is *computed*, never
   * typed), and a validation rule may `reject()` the write outright — in which case
   * nothing reaches the store, there is nothing to roll back, and the result comes
   * back `{ ok: false, rejectedReason }`.
   *
   * Asynchronous because a real topology check is a round-trip to a parcel registry.
   * Callers on the interaction path fire and forget; the map updates when it lands.
   *
   * ```ts
   * const result = await map.commands.commit(
   *   new AddFeaturesCommand('parcels', [{ geometry, properties: { ada: '123' } }]),
   * )
   * if (!result.ok) toast(result.rejectedReason)   // "Parcel overlaps parcel 47/12"
   * ```
   */
  commit<R>(command: CommitCommand<R>): Promise<DispatchResult<R>>

  /**
   * Group everything dispatched inside `fn` into one atomic, single-undo unit.
   *
   * If `fn` throws, every command already executed inside it is rolled back —
   * so a half-completed parcel split cannot be left on screen.
   *
   * ```ts
   * map.commands.transaction('Highlight', () => {
   *   map.commands.dispatch(new SetPreviewCommand(geometry))
   *   map.commands.dispatch(new SetHandlesCommand(handles))
   * })   // → one entry in the undo stack
   * ```
   */
  transaction(label: string, fn: () => void): DispatchResult<void>

  /**
   * The same, for work that commits — so a parcel split is *one* undo step even
   * though it is a remove and an add, each of which had to clear the pipeline
   * independently.
   *
   * Every `commit()` inside `fn` is validated on its own, against the store as the
   * previous step left it. If any of them is vetoed, or `fn` throws, the whole
   * transaction rolls back to the snapshot taken before it started — so a rejected
   * *second half* of a split cannot leave you with the original parcel deleted and
   * nothing in its place.
   *
   * ```ts
   * await map.commands.commitTransaction('Split parcel', async () => {
   *   await map.commands.commit(new RemoveFeaturesCommand([parcel.id]))
   *   await map.commands.commit(new AddFeaturesCommand('parcels', [left, right]))
   * })
   * ```
   */
  commitTransaction(label: string, fn: () => Promise<void>): Promise<DispatchResult<void>>

  /** Fires after a command executes successfully. This is the history plugin's hook. */
  onDidExecute(
    handler: (command: Command, transaction: string | null, origin: CommandOrigin) => void,
  ): Disposable
}

/** Where a command came from. */
export interface CommandOrigin {
  /**
   * The command was dispatched *while an undo or redo was replaying*.
   *
   * History must not record these, and the reason is worth stating because the bug it
   * prevents is invisible. A product may keep an audit trail by listening for
   * `feature:removed` and writing a record of it. Press Ctrl-Z: the undo removes the
   * feature, the listener fires, and it commits its audit record. If history recorded
   * *that*, the user's next Ctrl-Z would undo the bookkeeping instead of their own
   * previous action — and worse, recording anything clears the redo stack, so the redo
   * they just earned by pressing undo would be silently destroyed.
   *
   * The flag is captured **synchronously, when the command is submitted**, not when it
   * executes. That distinction is the whole point: `commit()` awaits the pipeline, so by
   * the time the write lands the replay has long since finished, and a flag read at
   * execution time would always say `false`.
   */
  readonly replay: boolean
}
