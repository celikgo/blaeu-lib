import type {
  Disposable,
  FeatureId,
  LngLat,
  SnapKind,
  SnapProvider,
  SnapResult,
} from '@fleximap/core'

export interface SnapOptions {
  /** Screen pixels. How close is "close". Default 10. */
  readonly tolerance?: number

  /**
   * Which built-in providers to install.
   *
   * Defaults to every built-in that can work: vertex, intersection, midpoint, edge,
   * extension and perpendicular — plus `grid`, but only if a {@link gridSize} was
   * given, because a grid provider with no grid has nothing to offer.
   *
   * A kind that is not a built-in is ignored here; register it yourself with
   * `map.plugin('snap').addProvider(...)`. That is the extension point, and it is
   * how a cadastre plugin adds `'parcel-corner'` or a game plugin adds
   * `'hex-centre'`.
   */
  readonly providers?: readonly SnapKind[]

  /** Grid spacing in **metres, in the working CRS**. Omit for no grid snapping. */
  readonly gridSize?: number

  /** Start snapping enabled. Default `true`. */
  readonly enabled?: boolean
}

/**
 * The snap engine's public API.
 *
 * Notice what is *not* here: any way for a tool to ask "where should this point
 * go?". Snapping is interaction middleware — it rewrites `ctx.lngLat` before any
 * tool sees the event — so a tool never calls the snap engine, and the draw plugin
 * has never heard of it. Everything below is for *configuring* snapping, or for the
 * gesture-scoped bookkeeping (`exclude`, `setInProgress`) that only the plugin
 * currently driving a gesture can know.
 */
export interface SnapApi {
  /**
   * Register a source of snap targets. Every tool in the product — including tools
   * written by strangers next year — snaps to them from the next pointer move.
   */
  addProvider(provider: SnapProvider): Disposable

  removeProvider(id: string): void

  providers(): readonly SnapProvider[]

  /** Screen pixels. Throws on a non-positive tolerance — a zero tolerance is a disabled engine, said confusingly. */
  setTolerance(px: number): void

  /** What the last pointer event snapped to, or `undefined` if it snapped to nothing. */
  readonly current: SnapResult | undefined

  enable(): void
  disable(): void

  /**
   * Features to ignore.
   *
   * Set this to the feature being dragged or reshaped, or it will snap to itself:
   * the vertex under the cursor *is* the vertex you are moving, it is at distance
   * zero, and it wins every time. Replaces the previous exclusion set; pass an
   * empty iterable to clear it.
   */
  exclude(ids: Iterable<FeatureId>): void

  /**
   * The vertices committed so far in the current gesture.
   *
   * Two things depend on it, and both are invisible until they are missing: closing
   * a ring by clicking its first vertex (the vertex provider snaps to these), and
   * the perpendicular provider, which drops its perpendicular *from* the last one.
   *
   * The drawing plugin owns this; the snap plugin has no way to know a gesture is in
   * progress, and deliberately does not try to guess.
   */
  setInProgress(points: readonly LngLat[]): void
}
