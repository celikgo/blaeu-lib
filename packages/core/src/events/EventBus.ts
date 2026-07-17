import type {
  CancellableEventHandler,
  CancellableEventName,
  CancellableBlaeuEvent,
  EventBus,
  EventHandler,
  BlaeuEvent,
  BlaeuEventMap,
  BlaeuEventName,
  ListenerOptions,
} from '../types/events.js'
import type { Disposable } from '../types/common.js'

interface Listener {
  readonly handler: (event: BlaeuEvent<unknown>) => void
  readonly priority: number
  readonly once: boolean
  disposed: boolean
}

class BlaeuEventImpl<T> implements CancellableBlaeuEvent<T> {
  propagationStopped = false
  defaultPrevented = false
  cancelReason: string | undefined = undefined

  constructor(
    readonly type: string,
    readonly payload: T,
    private readonly cancellable: boolean,
  ) {}

  stopPropagation(): void {
    this.propagationStopped = true
  }

  preventDefault(reason?: string): void {
    if (!this.cancellable) {
      // Loud, because a silently-ignored preventDefault is a validation rule that
      // *thinks* it blocked an illegal edit and didn't. Better to shout.
      console.warn(
        `[blaeu] preventDefault() on non-cancellable event "${this.type}". ` +
          `Only "before:*" events can be cancelled.`,
      )
      return
    }
    this.defaultPrevented = true
    this.cancelReason = reason
  }
}

/**
 * The strongly-typed event bus.
 *
 * Two design choices worth defending:
 *
 * **Listeners are sync.** The bus is on the hot path — store writes, pointer
 * events — and an `async` handler would resolve after the emitting code had moved
 * on, silently reordering under load. Kick async work off *from* a sync handler.
 *
 * **Listeners are snapshotted before dispatch.** A handler that adds or removes
 * listeners (which happens constantly: `once`, and plugins that re-subscribe on
 * enable) must not mutate the array being iterated. Copying costs an allocation
 * per emit and buys immunity to an entire family of "sometimes a listener is
 * skipped" bugs. Worth it.
 */
export class BlaeuEventBus implements EventBus {
  #listeners = new Map<string, Listener[]>()
  #wildcards: { pattern: string; prefix: string; listener: Listener }[] = []

  on<K extends BlaeuEventName>(
    type: K,
    handler: EventHandler<BlaeuEventMap[K]>,
    options: ListenerOptions = {},
  ): Disposable {
    return this.#add(type, handler as (e: BlaeuEvent<unknown>) => void, options)
  }

  onBefore<K extends CancellableEventName>(
    type: K,
    handler: CancellableEventHandler<BlaeuEventMap[K]>,
    options: ListenerOptions = {},
  ): Disposable {
    return this.#add(type, handler as (e: BlaeuEvent<unknown>) => void, options)
  }

  onAny(
    pattern: string,
    handler: EventHandler<unknown>,
    options: ListenerOptions = {},
  ): Disposable {
    if (!pattern.endsWith('*')) {
      throw new Error(`[blaeu] onAny pattern must end with "*", got "${pattern}"`)
    }
    const listener: Listener = {
      handler: handler as (e: BlaeuEvent<unknown>) => void,
      priority: options.priority ?? 0,
      once: options.once ?? false,
      disposed: false,
    }
    const entry = { pattern, prefix: pattern.slice(0, -1), listener }
    this.#wildcards.push(entry)
    this.#wildcards.sort((a, b) => b.listener.priority - a.listener.priority)

    const disposable: Disposable = {
      dispose: () => {
        listener.disposed = true
        const i = this.#wildcards.indexOf(entry)
        if (i >= 0) this.#wildcards.splice(i, 1)
      },
    }
    options.signal?.addEventListener('abort', () => disposable.dispose(), { once: true })
    return disposable
  }

  #add(
    type: string,
    handler: (event: BlaeuEvent<unknown>) => void,
    options: ListenerOptions,
  ): Disposable {
    const listener: Listener = {
      handler,
      priority: options.priority ?? 0,
      once: options.once ?? false,
      disposed: false,
    }

    let list = this.#listeners.get(type)
    if (!list) {
      list = []
      this.#listeners.set(type, list)
    }
    list.push(listener)
    // Stable sort, so equal priorities keep registration order. That matters:
    // two validators at the same priority should veto in the order the preset
    // listed them, which is the order the author expected to reason about.
    list.sort((a, b) => b.priority - a.priority)

    const disposable: Disposable = {
      dispose: () => {
        if (listener.disposed) return
        listener.disposed = true
        const current = this.#listeners.get(type)
        if (!current) return
        const i = current.indexOf(listener)
        if (i >= 0) current.splice(i, 1)
        if (current.length === 0) this.#listeners.delete(type)
      },
    }
    options.signal?.addEventListener('abort', () => disposable.dispose(), { once: true })
    return disposable
  }

  emit<K extends BlaeuEventName>(type: K, payload: BlaeuEventMap[K]): void {
    const event = new BlaeuEventImpl(type, payload, false)
    this.#dispatch(type, event)
  }

  emitCancellable<K extends CancellableEventName>(
    type: K,
    payload: BlaeuEventMap[K],
  ): { allowed: boolean; reason: string | undefined } {
    const event = new BlaeuEventImpl(type, payload, true)
    this.#dispatch(type, event)
    return { allowed: !event.defaultPrevented, reason: event.cancelReason }
  }

  #dispatch(type: string, event: BlaeuEventImpl<unknown>): void {
    const list = this.#listeners.get(type)
    if (list && list.length > 0) {
      // Snapshot — see the class doc. A `once` listener disposing itself mid-loop
      // would otherwise shift the array and skip its neighbour.
      for (const listener of [...list]) {
        if (listener.disposed) continue
        if (event.propagationStopped) break
        if (listener.once) listener.disposed = true
        this.#invoke(listener, event, type)
      }
      // Sweep spent `once` listeners.
      const remaining = list.filter((l) => !l.disposed)
      if (remaining.length !== list.length) {
        if (remaining.length === 0) this.#listeners.delete(type)
        else this.#listeners.set(type, remaining)
      }
    }

    if (this.#wildcards.length > 0 && !event.propagationStopped) {
      for (const { prefix, listener } of [...this.#wildcards]) {
        if (listener.disposed) continue
        if (event.propagationStopped) break
        if (!type.startsWith(prefix)) continue
        if (listener.once) listener.disposed = true
        this.#invoke(listener, event, type)
      }
      this.#wildcards = this.#wildcards.filter((w) => !w.listener.disposed)
    }
  }

  #invoke(listener: Listener, event: BlaeuEventImpl<unknown>, type: string): void {
    try {
      listener.handler(event)
    } catch (err) {
      // One broken listener must not stop the others, and must not take down the
      // map. A plugin throwing in a `feature:added` handler should not prevent the
      // renderer's handler from repainting.
      console.error(`[blaeu] listener for "${type}" threw:`, err)
    }
  }

  listenerCount(type?: string): number {
    if (type !== undefined) return this.#listeners.get(type)?.length ?? 0
    let total = this.#wildcards.length
    for (const list of this.#listeners.values()) total += list.length
    return total
  }

  /** @internal Teardown. */
  clear(): void {
    this.#listeners.clear()
    this.#wildcards = []
  }
}
