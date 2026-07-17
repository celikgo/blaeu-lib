import type { Disposable } from '../types/common.js'
import type {
  Command,
  CommandBus,
  CommandContext,
  CommandOrigin,
  CommitCommand,
  CommitIntent,
  DispatchResult,
} from '../types/command.js'
import { isCommitCommand } from '../types/command.js'
import type { BlaeuEventBus } from '../events/EventBus.js'
import type { FeatureStore, StoreSnapshot } from '../types/store.js'
import type { CommitContext, CommitPipeline } from '../types/pipeline.js'
import type { BlaeuFeature } from '../types/feature.js'

/**
 * The mutable context middleware sees. One per commit.
 *
 * `features` is deliberately a plain mutable array: a middleware stamping a derived
 * area does `ctx.features = ctx.features.map(...)`, and that has to be the most
 * obvious thing in the world to write, or people will reach around the pipeline and
 * write to the store directly.
 */
class BlaeuCommitContext implements CommitContext {
  readonly operation: 'add' | 'update' | 'remove'
  readonly previous: readonly BlaeuFeature[]
  readonly command: Command | undefined

  features: BlaeuFeature[]

  #rejected = false
  #reason: string | undefined

  constructor(intent: CommitIntent, command: Command) {
    this.operation = intent.operation
    this.previous = intent.previous
    this.features = [...intent.features]
    this.command = command
  }

  reject(reason: string): void {
    // First veto wins. A later middleware cannot overwrite an earlier rule's reason
    // with a vaguer one — the user should be told the *first* thing that was wrong
    // with their parcel, not the last.
    if (this.#rejected) return
    this.#rejected = true
    this.#reason = reason
  }

  get rejected(): boolean {
    return this.#rejected
  }

  get rejectReason(): string | undefined {
    return this.#reason
  }
}

/**
 * Groups commands so that a multi-step operation is one undo step.
 *
 * A parcel split is *remove one parcel, add two* — three store writes the user
 * thinks of as one action. Without this, undoing a split leaves you with one
 * parcel deleted and nothing in its place, which is worse than not having undo.
 */
export class CompositeCommand implements Command<void> {
  readonly type = 'core:transaction'

  constructor(
    readonly label: string,
    readonly children: readonly Command[],
  ) {}

  execute(ctx: CommandContext): void {
    for (const child of this.children) child.execute(ctx)
  }

  undo(ctx: CommandContext): void {
    // Reverse order. Undoing "remove A, add B" as "remove A, add B" reversed is
    // "remove B, add A" — do it forwards and you try to re-add A while B still
    // occupies its geometry, which a topology validator will (correctly) reject.
    for (let i = this.children.length - 1; i >= 0; i--) {
      this.children[i]!.undo(ctx)
    }
  }
}

/**
 * Dispatches commands. Holds **no undo stack** — that is deliberate.
 *
 * History is a *plugin* that subscribes to `onDidExecute`. Keeping it out of the
 * kernel means a read-only viewer doesn't pay for undo it will never use, and —
 * more interestingly — a collaborative product can swap in a history plugin
 * backed by operational transforms without the core, or any other plugin, being
 * aware that undo now works across a network.
 */
export class BlaeuCommandBus implements CommandBus {
  #handlers: ((command: Command, transaction: string | null, origin: CommandOrigin) => void)[] = []
  /** True only while `_apply` is running a command backwards or forwards. */
  #replaying = false
  #transaction: { label: string; children: Command[] } | null = null
  /** The first veto seen inside the open `commitTransaction`, if any. */
  #vetoed: string | undefined
  /** Tail of the serialised write queue. See {@link BlaeuCommandBus.#enqueue}. */
  #queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: FeatureStore,
    private readonly events: BlaeuEventBus,
    private readonly pipeline: CommitPipeline,
  ) {}

  get #ctx(): CommandContext {
    return { store: this.store, events: this.events }
  }

  dispatch<R>(command: Command<R> & { intent?: never }): DispatchResult<R> {
    // TypeScript already refuses a CommitCommand here (`intent?: never`). This is
    // the backstop for JavaScript callers and for anyone who reached for `as any`:
    // a feature-writing command that slips onto the synchronous path would skip
    // every validation rule in the product and land straight in the store, and the
    // only symptom would be a rule that silently never fires. Fail loudly instead.
    // Widen back to `Command<R>` first: the `intent?: never` in the signature is what
    // makes TypeScript refuse a CommitCommand, but it also means the intersection
    // TypeScript hands us here has already collapsed to `never`, and the guard would
    // have nothing to narrow.
    const candidate: Command<R> = command
    if (isCommitCommand(candidate)) {
      throw new Error(
        `[blaeu] "${candidate.type}" writes features, so it must go through commands.commit() ` +
          `(async, runs the commit pipeline), not commands.dispatch() (sync, does not). ` +
          `dispatch() is for transient, non-durable commands — previews, handles, highlights.`,
      )
    }
    return this.#execute(candidate, this.#origin())
  }

  commit<R>(command: CommitCommand<R>): Promise<DispatchResult<R>> {
    // Capture the origin NOW, synchronously, while we are still on the call stack of
    // whoever submitted this. By the time the write actually lands we will have awaited
    // the pipeline and possibly a queue, and any replay that was in progress will have
    // finished — so reading the flag later would always answer `false`, and history
    // would record the echo of its own undo.
    const origin = this.#origin()

    // Already inside an open transaction *on this call stack* — run inline. Enqueueing
    // here would deadlock: the transaction holds the queue while it awaits `fn()`, and
    // `fn()` is what is calling us.
    if (this.#transaction) return this.#commitNow(command, origin)

    // Otherwise take a turn in the queue. See #enqueue.
    return this.#enqueue(() => this.#commitNow(command, origin))
  }

  #origin(): CommandOrigin {
    return { replay: this.#replaying }
  }

  async #commitNow<R>(
    command: CommitCommand<R>,
    origin: CommandOrigin,
  ): Promise<DispatchResult<R>> {
    let intent: CommitIntent
    try {
      intent = command.intent(this.#ctx)
    } catch (err) {
      return this.#fail(err, `commit:${command.type}`)
    }

    const ctx = new BlaeuCommitContext(intent, command)

    let result: CommitContext
    try {
      result = await this.pipeline.run(ctx)
    } catch (err) {
      // A middleware that throws fails *closed*. The alternative — treating a
      // crashed topology check as a pass — is how invalid geometry gets into a land
      // registry: the one time the validator was broken is the one time nothing
      // stopped the bad write.
      return this.#fail(err, `commit:${command.type}`)
    }

    if (result.rejected) {
      const reason = result.rejectReason ?? 'rejected'
      // Remember it, so an enclosing commitTransaction rolls the whole group back
      // rather than committing the half of a split that happened to be legal.
      this.#vetoed ??= reason
      this.events.emit('commit:rejected', { command, reason })
      return { ok: false, value: undefined, rejectedReason: reason }
    }

    // Whatever survived the chain is what lands. Middleware rewrites are not
    // advisory.
    command.adopt(result.features)
    return this.#execute(command, origin)
  }

  commitTransaction(label: string, fn: () => Promise<void>): Promise<DispatchResult<void>> {
    // Nested — flatten into the open one, as the sync version does. Inline, not queued,
    // for the same reason as `commit`.
    if (this.#transaction) {
      return fn().then(
        () => ({ ok: true, value: undefined, rejectedReason: undefined }),
        (err: unknown) => this.#fail(err, `transaction:${label}`),
      )
    }

    return this.#enqueue(() => this.#transactionNow(label, fn))
  }

  /**
   * One write at a time, in call order.
   *
   * `#transaction` is a single mutable field, and the moment writes became
   * asynchronous it stopped being safe to read after an `await`. Consider a measure
   * session whose `begin()` fires an un-awaited `clear()`: that `clear()` is still
   * inside `await pipeline.run(...)` when the user's double-click opens `complete()`'s
   * transaction. It resumes, looks at `#transaction`, finds one open — *not its own* —
   * and files its removal as a child of someone else's undo group. The store ends up
   * correct, so no assertion catches it; the undo stack does not, and one Ctrl-Z
   * silently undoes both the clear and the new measurement.
   *
   * Serialising the write path removes the interleaving rather than trying to detect
   * it. Writes are not the hot path — the interaction pipeline is, and it stays
   * synchronous — so the cost is a queue on an operation that was already awaiting a
   * possible network round-trip. Ordering is now also deterministic, which a store
   * that anything replays (undo, collaboration, a crash log) needs anyway.
   */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    // Chain off the tail regardless of whether it settled or threw: one rejected commit
    // must not wedge the queue for every write after it.
    const run = this.#queue.then(task, task)
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #transactionNow(label: string, fn: () => Promise<void>): Promise<DispatchResult<void>> {
    const before: StoreSnapshot = this.store.snapshot()
    const origin = this.#origin()
    this.#transaction = { label, children: [] }

    try {
      await fn()
    } catch (err) {
      this.store.restore(before)
      this.#transaction = null
      return this.#fail(err, `transaction:${label}`)
    }

    // A veto inside the transaction is not an exception — `commit()` returns
    // `{ ok: false }` — so a caller who does not check it would otherwise get a
    // half-applied split: the parcel removed, the two halves rejected, and nothing
    // on screen. Roll back to the snapshot instead, and say why.
    const vetoed = this.#vetoed
    this.#vetoed = undefined
    if (vetoed !== undefined) {
      this.store.restore(before)
      this.#transaction = null
      return { ok: false, value: undefined, rejectedReason: vetoed }
    }

    return this.#close(label, origin)
  }

  #execute<R>(command: Command<R>, origin: CommandOrigin): DispatchResult<R> {
    // The cancellable hook. A plugin vetoes here, before anything has touched the
    // store — so there is nothing to roll back.
    const gate = this.events.emitCancellable('before:command:execute', { command })
    if (!gate.allowed) {
      return { ok: false, value: undefined, rejectedReason: gate.reason ?? 'rejected' }
    }

    // Inside a transaction: execute now (so later commands in the transaction see
    // the effect), but record into the group rather than announcing individually.
    if (this.#transaction) {
      const value = command.execute(this.#ctx)
      this.#transaction.children.push(command)
      return { ok: true, value, rejectedReason: undefined }
    }

    let value: R
    try {
      value = command.execute(this.#ctx)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.events.emit('map:error', {
        error: err instanceof Error ? err : new Error(reason),
        source: `command:${command.type}`,
      })
      return { ok: false, value: undefined, rejectedReason: reason }
    }

    if (!command.transient) {
      this.#notify(command, null, origin)
      this.events.emit('command:executed', { command, transaction: null })
    }
    return { ok: true, value, rejectedReason: undefined }
  }

  transaction(label: string, fn: () => void): DispatchResult<void> {
    if (this.#transaction) {
      // Nested transactions flatten into the outer one. The alternative — a tree of
      // nested undo groups — is a UI nobody has ever wanted: the user pressed
      // Ctrl-Z once and expects one coherent thing to be undone.
      fn()
      return { ok: true, value: undefined, rejectedReason: undefined }
    }

    // Snapshot up front so a throw mid-transaction can't leave a half-split parcel
    // on screen. Cheap because the store is structurally shared.
    const before: StoreSnapshot = this.store.snapshot()
    this.#transaction = { label, children: [] }

    const origin = this.#origin()

    try {
      fn()
    } catch (err) {
      this.store.restore(before)
      this.#transaction = null
      return this.#fail(err, `transaction:${label}`)
    }

    return this.#close(label, origin)
  }

  /** Roll the open group up into one undo entry and announce it. */
  #close(label: string, origin: CommandOrigin): DispatchResult<void> {
    const children = this.#transaction?.children ?? []
    this.#transaction = null

    // Transient children have already run against the store, but they are not
    // history. Filter first, and *then* ask whether there is anything to record:
    // a transaction whose children were all transient (a gesture that only redrew
    // a preview, say) has nothing to undo, and announcing an empty CompositeCommand
    // would push an undo entry whose undo() is a no-op — silently swallowing the
    // user's next Ctrl-Z.
    const recordable = children.filter((c) => !c.transient)
    if (recordable.length === 0) {
      return { ok: true, value: undefined, rejectedReason: undefined }
    }

    // Collapse a one-command transaction rather than wrapping it. The undo menu
    // should say "Move vertex", not "Transaction".
    const composite =
      recordable.length === 1 ? recordable[0]! : new CompositeCommand(label, recordable)

    this.#notify(composite, label, origin)
    this.events.emit('command:executed', { command: composite, transaction: label })
    return { ok: true, value: undefined, rejectedReason: undefined }
  }

  /** Announce a failure on `map:error` and turn it into a rejected result. */
  #fail(err: unknown, source: string): DispatchResult<never> {
    const reason = err instanceof Error ? err.message : String(err)
    this.events.emit('map:error', {
      error: err instanceof Error ? err : new Error(reason),
      source,
    })
    return { ok: false, value: undefined, rejectedReason: reason }
  }

  onDidExecute(
    handler: (command: Command, transaction: string | null, origin: CommandOrigin) => void,
  ): Disposable {
    this.#handlers.push(handler)
    return {
      dispose: () => {
        const i = this.#handlers.indexOf(handler)
        if (i >= 0) this.#handlers.splice(i, 1)
      },
    }
  }

  #notify(command: Command, transaction: string | null, origin: CommandOrigin): void {
    for (const handler of [...this.#handlers]) {
      try {
        handler(command, transaction, origin)
      } catch (err) {
        console.error('[blaeu] command subscriber threw:', err)
      }
    }
  }

  /** @internal Used by the history plugin to replay. Bypasses the before-hook by design. */
  _apply(command: Command, direction: 'undo' | 'redo'): void {
    // Anything submitted while this is true — including by a listener reacting to the
    // store change the replay just caused — is an echo of the replay, not a new user
    // action. `commit()` reads this synchronously at submission and carries it forward.
    this.#replaying = true
    try {
      this.#applyNow(command, direction)
    } finally {
      this.#replaying = false
    }
  }

  #applyNow(command: Command, direction: 'undo' | 'redo'): void {
    if (direction === 'undo') {
      command.undo(this.#ctx)
      this.events.emit('command:undone', { command })
    } else {
      const redo = command.redo?.bind(command) ?? command.execute.bind(command)
      redo(this.#ctx)
      this.events.emit('command:redone', { command })
    }
  }
}
