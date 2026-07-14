import type { Disposable, LngLat } from './common.js'
import type { FlexiFeature } from './feature.js'
import type { Command } from './command.js'
import type { ValidationIssue } from './validation.js'

/**
 * The global event map.
 *
 * Plugins **augment this interface** from their own entry points, and thereby
 * teach the core's event bus about their events without the core knowing they
 * exist:
 *
 * ```ts
 * declare module '@fleximap/core' {
 *   interface FlexiEventMap {
 *     'draw:complete': { feature: FlexiFeature }
 *     'before:draw:complete': { feature: FlexiFeature }
 *   }
 * }
 * ```
 *
 * After that, `map.events.on('draw:complete', e => e.feature)` type-checks with
 * full inference, and a typo in the event name is a compile error. This is the
 * mechanism that makes a third-party plugin feel exactly as first-class as a
 * built-in one.
 *
 * ### The `before:` convention is enforced by the type system
 *
 * An event named `before:*` is a **cancellable hook**: handlers may call
 * `preventDefault()` and the action will not happen. Everything else is a
 * past-tense notification and cannot be cancelled. This isn't documentation —
 * {@link EventBus.emitCancellable} only accepts keys matching
 * `` `before:${string}` ``, so the two channels cannot be confused.
 */
export interface FlexiEventMap {
  /* ---- lifecycle ---- */
  'map:ready': { readonly at: number }
  'map:destroy': Record<string, never>
  'map:error': { readonly error: Error; readonly source: string }

  /* ---- camera ---- */
  'camera:move': { readonly center: LngLat; readonly zoom: number; readonly bearing: number }
  'camera:idle': { readonly center: LngLat; readonly zoom: number }

  /* ---- store ---- */
  'feature:added': { readonly features: readonly FlexiFeature[] }
  'feature:updated': {
    readonly features: readonly FlexiFeature[]
    readonly previous: readonly FlexiFeature[]
  }
  'feature:removed': { readonly features: readonly FlexiFeature[] }
  'before:feature:add': { readonly features: readonly FlexiFeature[] }
  'before:feature:update': { readonly features: readonly FlexiFeature[] }
  'before:feature:remove': { readonly features: readonly FlexiFeature[] }

  /* ---- commands / history ---- */
  'command:executed': { readonly command: Command; readonly transaction: string | null }
  'command:undone': { readonly command: Command }
  'command:redone': { readonly command: Command }
  'before:command:execute': { readonly command: Command }

  /**
   * A write was refused by the commit pipeline — a validation rule said no, or a
   * middleware threw and the pipeline failed closed.
   *
   * Nothing reached the store, so there is nothing to undo. This is the hook a UI
   * uses to say *why*: a toast, an inline error on the parcel, a rejected-writes
   * log. Without it the only observable effect of a veto is that the map didn't
   * change, which the user reads as "the software is broken".
   */
  'commit:rejected': { readonly command: Command; readonly reason: string }

  /* ---- validation ---- */
  'validation:failed': { readonly issues: readonly ValidationIssue[] }

  /* ---- plugins ---- */
  'plugin:registered': { readonly id: string }
  'plugin:enabled': { readonly id: string }
  'plugin:disabled': { readonly id: string }
  'plugin:removed': { readonly id: string }

  /* ---- tools ---- */
  'tool:activated': { readonly id: string; readonly previous: string | null }
  'tool:deactivated': { readonly id: string }
  'before:tool:activate': { readonly id: string; readonly previous: string | null }
}

/** Every event name currently known to the type system. */
export type FlexiEventName = keyof FlexiEventMap & string

/** Only the cancellable ones. The `before:` prefix *is* the capability. */
export type CancellableEventName = FlexiEventName & `before:${string}`

/** The object handed to a listener. */
export interface FlexiEvent<T> {
  readonly type: string
  readonly payload: T
  /** Stops later listeners on this event from running. */
  stopPropagation(): void
  readonly propagationStopped: boolean
}

/**
 * A cancellable event. Only ever passed to `before:*` listeners.
 *
 * `preventDefault()` vetoes the pending action — the feature is not added, the
 * tool is not activated, the command does not execute. This is what lets a
 * validation plugin block an illegal parcel edit without the store, the draw
 * plugin, or the command bus knowing that validation exists.
 */
export interface CancellableFlexiEvent<T> extends FlexiEvent<T> {
  preventDefault(reason?: string): void
  readonly defaultPrevented: boolean
  /** Populated by whichever listener cancelled, for user-facing error messages. */
  readonly cancelReason: string | undefined
}

export type EventHandler<T> = (event: FlexiEvent<T>) => void
export type CancellableEventHandler<T> = (event: CancellableFlexiEvent<T>) => void

export interface ListenerOptions {
  /**
   * Higher runs first. Default 0.
   *
   * Priority exists chiefly for `before:` hooks, where order decides which
   * validator gets to veto first and therefore which error message the user
   * actually sees. Presets rely on this to put cheap checks ahead of expensive
   * ones.
   */
  readonly priority?: number
  /** Auto-dispose after the first call. */
  readonly once?: boolean
  /** Abort signal that disposes the listener. Convenient inside React effects. */
  readonly signal?: AbortSignal
}

/**
 * The strongly-typed event bus.
 *
 * Handlers are sync by design: the bus is on the hot path (pointer moves,
 * store writes) and an async handler would silently reorder under load. Do async
 * work by kicking it off from a sync handler.
 */
export interface EventBus {
  on<K extends FlexiEventName>(
    type: K,
    handler: EventHandler<FlexiEventMap[K]>,
    options?: ListenerOptions,
  ): Disposable

  /**
   * Subscribe to a cancellable hook. Overloaded separately from `on` so that
   * `preventDefault` is only visible where it actually works — if it were on the
   * base event, every listener would appear able to cancel, and most cannot.
   */
  onBefore<K extends CancellableEventName>(
    type: K,
    handler: CancellableEventHandler<FlexiEventMap[K]>,
    options?: ListenerOptions,
  ): Disposable

  /** Subscribe to a namespace: `draw:*` catches `draw:start`, `draw:complete`, … */
  onAny(pattern: string, handler: EventHandler<unknown>, options?: ListenerOptions): Disposable

  emit<K extends FlexiEventName>(type: K, payload: FlexiEventMap[K]): void

  /**
   * Emit a cancellable hook.
   * @returns `true` if the action may proceed, `false` if a listener vetoed it.
   */
  emitCancellable<K extends CancellableEventName>(
    type: K,
    payload: FlexiEventMap[K],
  ): { readonly allowed: boolean; readonly reason: string | undefined }

  /** Live listener count. The teardown test asserts this returns to zero. */
  listenerCount(type?: string): number
}
