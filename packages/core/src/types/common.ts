/**
 * Primitive types shared by every layer of FlexiMap.
 *
 * These are deliberately structural (tuples and plain objects, not classes) so
 * that geometry can cross the plugin boundary — and the network — without
 * serialisation ceremony.
 */

/**
 * A geographic position, **always** `[longitude, latitude]` in EPSG:4326.
 *
 * The order is lng-then-lat because that is what GeoJSON (RFC 7946) mandates and
 * what MapLibre expects. It is the opposite of the lat/lng order used by Leaflet
 * and by most humans, which is a perennial source of "my point is in the ocean"
 * bugs. The type alias exists so that the intent is greppable even though the
 * runtime representation is just an array.
 *
 * Interior coordinates are 4326 without exception — see core invariant 3. If you
 * are holding projected metres, you are holding a {@link ProjectedXY}, and the
 * type system will keep the two apart.
 */
export type LngLat = readonly [lng: number, lat: number]

/** A position in a projected CRS, in that CRS's linear unit (metres, for every CRS we ship). */
export type ProjectedXY = readonly [x: number, y: number]

/** A position in screen space, in CSS pixels relative to the map container's top-left. */
export interface ScreenPoint {
  readonly x: number
  readonly y: number
}

/** `[west, south, east, north]` in EPSG:4326 — the GeoJSON bbox order. */
export type Bbox = readonly [west: number, south: number, east: number, north: number]

/**
 * Identifies a feature. Strings, because a land registry's parcel ID is a string
 * and forcing it through a number loses leading zeros — which are meaningful.
 */
export type FeatureId = string

/** Identifies a collection within the {@link FeatureStore}. Maps 1:1 to a renderer source. */
export type CollectionId = string

/**
 * Anything holding a resource that must be released.
 *
 * Every `on()`, `use()`, and `register()` in FlexiMap returns one of these, and
 * plugins are required to hand them to `ctx.disposables` (core invariant 5). The
 * shape matches the TC39 explicit-resource-management proposal deliberately, so
 * `using sub = events.on(...)` will Just Work once that lands.
 */
export interface Disposable {
  dispose(): void
}

/** A bag of disposables that disposes them all, exactly once, in reverse order. */
export class DisposableStore implements Disposable {
  #items: Disposable[] = []
  #disposed = false

  /** Registers a disposable. Returns it, so calls can be inlined. */
  add<T extends Disposable>(item: T): T {
    if (this.#disposed) {
      // Disposing immediately (rather than throwing) makes teardown races benign:
      // a plugin that registers a listener during its own destroy() gets a no-op,
      // not a crash — and definitely not a leak.
      item.dispose()
      return item
    }
    this.#items.push(item)
    return item
  }

  /** Wraps a bare cleanup function as a disposable and registers it. */
  addFn(fn: () => void): Disposable {
    return this.add({ dispose: fn })
  }

  get size(): number {
    return this.#items.length
  }

  get disposed(): boolean {
    return this.#disposed
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    // Reverse order: later registrations may depend on earlier ones, exactly as
    // with a stack of `finally` blocks.
    for (let i = this.#items.length - 1; i >= 0; i--) {
      try {
        this.#items[i]!.dispose()
      } catch (err) {
        // One misbehaving disposable must not strand the rest. Report and continue —
        // a half-torn-down map leaks listeners and is worse than a logged error.
        console.error('[fleximap] disposable threw during dispose:', err)
      }
    }
    this.#items = []
  }
}

/** Recursively optional. Used for config overrides and preset merging. */
export type DeepPartial<T> = T extends readonly unknown[] | Date | ((...a: never[]) => unknown)
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/** Recursively readonly. Used to hand out store snapshots that cannot be mutated in place. */
export type DeepReadonly<T> = T extends (...a: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

/** An arbitrary JSON-serialisable value. Feature properties are made of these. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** A logger. Swappable via config so host apps can route FlexiMap into their own telemetry. */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}
