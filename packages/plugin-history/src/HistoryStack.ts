import type {
  Command,
  CommandOrigin,
  Disposable,
  EventBus,
  FlexiCommandBus,
  Logger,
} from '@fleximap/core'
import type { ResolvedHistoryOptions } from './options.js'

/** What `map.plugin('history')` gives you. */
export interface HistoryApi {
  /** @returns false if there was nothing to undo, or the undo failed. */
  undo(): boolean
  /** @returns false if there was nothing to redo, or the redo failed. */
  redo(): boolean

  readonly canUndo: boolean
  readonly canRedo: boolean

  /** Label of the command Ctrl+Z would undo. Feed it straight to the menu item. */
  readonly undoLabel: string | undefined
  readonly redoLabel: string | undefined

  /** Forget everything. Both stacks. Use after a save, or after loading a document. */
  clear(): void

  /** Number of entries on the undo stack. */
  readonly depth: number

  /** Fires whenever either stack changes. The subscription is yours to dispose. */
  onChange(handler: () => void): Disposable
}

/**
 * Two stacks and a subscription. That is the entire undo system.
 *
 * It knows nothing about geometry, drawing, parcels or vertices — only that
 * something dispatched a {@link Command} and that a `Command` can be undone. This
 * is what makes undo work for a plugin written by a stranger in three years: they
 * implement `execute`/`undo`, dispatch through the bus, and get Ctrl+Z for free
 * without either of us having heard of the other.
 */
export class HistoryStack implements HistoryApi {
  readonly #bus: FlexiCommandBus
  readonly #events: EventBus
  readonly #log: Logger
  readonly #limit: number
  readonly #window: number

  #undoStack: Command[] = []
  #redoStack: Command[] = []
  #handlers: (() => void)[] = []

  /** When the current top of the undo stack landed. Drives the coalesce window. */
  #lastPushAt = 0

  /**
   * True while `_apply` is running a command backwards or forwards.
   *
   * This is the least obvious line in the plugin, so: an undo can *cause a
   * dispatch*. The command's `undo()` re-adds features, a listener somewhere hears
   * `feature:added` and dispatches a command of its own to keep some derived state
   * in step — and that command arrives here, through `onDidExecute`, while we are
   * still mid-undo. Without this flag it would be pushed onto the undo stack (and
   * would clear the redo stack we are in the middle of writing to), so the user's
   * next Ctrl+Z would undo a bookkeeping command instead of their actual last
   * action, and the redo they just earned would have silently vanished.
   *
   * **It only catches the *synchronous* echo, and that is no longer enough.** A
   * listener that keeps an audit trail cannot write features synchronously any more —
   * durable writes go through `commands.commit()`, which awaits the commit pipeline —
   * so its command lands on a later microtask, by which time `_apply` has returned and
   * this flag is back to `false`. The echo would sail straight onto the undo stack.
   *
   * That is what `CommandOrigin.replay` is for: the kernel captures the replay state
   * **when the command is submitted**, not when it executes, and hands it to us through
   * `onDidExecute`. See {@link HistoryStack.record}. This flag stays because it is the
   * cheap, local, synchronous case and belt-and-braces here costs nothing.
   */
  #replaying = false

  /** `disable()` parks the recorder without discarding the stacks. */
  #recording = true

  constructor(
    bus: FlexiCommandBus,
    events: EventBus,
    options: ResolvedHistoryOptions,
    log: Logger,
  ) {
    this.#bus = bus
    this.#events = events
    this.#log = log
    this.#limit = options.limit
    this.#window = options.coalesceWindowMs
  }

  /* --------------------------------------------------------------------- */
  /* Recording                                                              */
  /* --------------------------------------------------------------------- */

  /**
   * The `onDidExecute` handler.
   *
   * `at` is injectable so the coalescing tests do not have to sleep. In production
   * it is always `Date.now()`, which is fine here: this is library code reacting
   * to a user gesture, not a workflow that must be reproducible.
   */
  record(command: Command, at: number = Date.now(), origin?: CommandOrigin): void {
    // `origin.replay` is the authoritative one — the kernel read it when the command was
    // *submitted*, so it is still true for an async echo that lands after the replay has
    // finished. `#replaying` catches the synchronous case and is kept as a cheap guard.
    if (this.#replaying || origin?.replay === true || !this.#recording) return

    // The bus already filters these out, but a transient command that reached the
    // undo stack would be maddening (Ctrl+Z steps back through hover previews), so
    // this is worth stating twice.
    if (command.transient === true) return

    const top = this.#undoStack[this.#undoStack.length - 1]

    // A gesture is not a stopwatch. The window is a heuristic for commands that
    // cannot say what they belong to (keystrokes: "did the user pause?" is the only
    // question available). A command that declares a `gesture` has already answered
    // exactly, so the wall clock does not get a vote on whether we even *ask* it:
    // a surveyor who drags a shared corner, pauses to read the coordinate, then
    // nudges it home made one gesture and owes exactly one Ctrl-Z.
    //
    // `coalesceWindowMs: 0` still means merging is off — gesture or not.
    const sameGesture =
      command.gesture !== undefined && top !== undefined && top.gesture === command.gesture
    const withinWindow = at - this.#lastPushAt <= this.#window
    const ask = this.#window > 0 && (sameGesture || withinWindow)
    const merged = top !== undefined && ask ? (command.coalesceWith?.(top) ?? null) : null

    if (merged !== null) {
      // Replace, don't push: one drag is one undo step, not two hundred.
      this.#undoStack[this.#undoStack.length - 1] = merged
    } else {
      this.#undoStack.push(command)
      if (this.#undoStack.length > this.#limit) {
        // Drop from the bottom. The oldest edit is the one the user is least likely
        // to want back, and an unbounded stack in a long digitising session pins
        // every feature version it ever saw in memory.
        this.#undoStack.splice(0, this.#undoStack.length - this.#limit)
      }
    }

    this.#lastPushAt = at
    // Linear history: doing something new makes the redo branch unreachable. Every
    // editor the user has ever used behaves this way, and the alternative (a tree)
    // is a UI nobody has asked for.
    this.#redoStack.length = 0
    this.#notify()
  }

  /* --------------------------------------------------------------------- */
  /* Replay                                                                 */
  /* --------------------------------------------------------------------- */

  undo(): boolean {
    if (this.#replaying) return false

    const command = this.#undoStack.pop()
    if (command === undefined) return false

    if (!this.#replay(command, 'undo')) {
      this.#undoStack.push(command)
      return false
    }

    this.#redoStack.push(command)
    // Nothing may coalesce into the new top: it belongs to a gesture the user has
    // already stepped away from.
    this.#lastPushAt = 0
    this.#notify()
    return true
  }

  redo(): boolean {
    if (this.#replaying) return false

    const command = this.#redoStack.pop()
    if (command === undefined) return false

    if (!this.#replay(command, 'redo')) {
      this.#redoStack.push(command)
      return false
    }

    this.#undoStack.push(command)
    if (this.#undoStack.length > this.#limit) {
      this.#undoStack.splice(0, this.#undoStack.length - this.#limit)
    }
    this.#lastPushAt = 0
    this.#notify()
    return true
  }

  #replay(command: Command, direction: 'undo' | 'redo'): boolean {
    this.#replaying = true
    try {
      // `_apply` is `@internal` on the concrete bus and is exactly what this plugin
      // exists for: it runs the command backwards without going through
      // `before:command:execute`, because a validation rule that vetoed the *undo*
      // of an edit it already accepted would strand the user in a state they cannot
      // leave.
      this.#bus._apply(command, direction)
      return true
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      // Leave the stacks exactly as they were (the caller pushes the command back)
      // and keep the map alive. A command whose undo throws is a bug in that
      // command, and a history plugin that dies with it takes every *other*
      // plugin's undo down too.
      this.#log.error(
        `${direction} of "${command.type}" threw: ${error.message}. The history stack is unchanged. ` +
          `Fix the command: undo(execute(s)) must restore s, and must not throw on a store it has already seen.`,
      )
      this.#events.emit('map:error', { error, source: `history:${direction}` })
      return false
    } finally {
      this.#replaying = false
    }
  }

  /* --------------------------------------------------------------------- */
  /* State                                                                  */
  /* --------------------------------------------------------------------- */

  get canUndo(): boolean {
    return this.#undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0
  }

  get undoLabel(): string | undefined {
    return this.#undoStack[this.#undoStack.length - 1]?.label
  }

  get redoLabel(): string | undefined {
    return this.#redoStack[this.#redoStack.length - 1]?.label
  }

  get depth(): number {
    return this.#undoStack.length
  }

  clear(): void {
    if (this.#undoStack.length === 0 && this.#redoStack.length === 0) return
    this.#undoStack = []
    this.#redoStack = []
    this.#lastPushAt = 0
    this.#notify()
  }

  onChange(handler: () => void): Disposable {
    this.#handlers.push(handler)
    return {
      dispose: () => {
        const i = this.#handlers.indexOf(handler)
        if (i >= 0) this.#handlers.splice(i, 1)
      },
    }
  }

  /** `disable()`/`enable()` on the plugin. Dormant, but the stacks survive. */
  setRecording(recording: boolean): void {
    this.#recording = recording
  }

  /** Drops the change handlers. The stacks go with the plugin. */
  dispose(): void {
    this.#handlers = []
    this.#undoStack = []
    this.#redoStack = []
  }

  #notify(): void {
    this.#events.emit('history:changed', {
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      depth: this.depth,
    })
    for (const handler of [...this.#handlers]) {
      try {
        handler()
      } catch (err) {
        // One broken toolbar button must not stop the next one from being redrawn.
        this.#log.error('a history onChange handler threw:', err)
      }
    }
  }
}
