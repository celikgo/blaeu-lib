import type { FeatureId, LineString, LngLat, ProjectedXY } from '@fleximap/core'

export interface EditOptions {
  /**
   * Move a shared corner in **every** feature that has one there, in one command.
   *
   * Off by default, because it is a surprise in a product that draws unrelated
   * shapes — a game map does not want moving a road to drag a building with it. It
   * is the *only* correct setting for cadastre: two parcels that share a boundary
   * must keep sharing it, and a system that lets them drift 3 cm apart has created
   * a strip of land with no owner. The cadastre preset turns it on.
   */
  readonly topological?: boolean

  /** Whether Alt-click / Delete removes a vertex. Default `true`. */
  readonly allowVertexDelete?: boolean

  /**
   * A floor on how few corners a ring may be reduced to. Raises the geometric
   * minimum (3 for a polygon, 2 for a line); it cannot lower it.
   */
  readonly minVertices?: number

  /** Grab radius for handles, in screen pixels. Default 10 — a fingertip on a tablet in the field. */
  readonly handleSize?: number
}

/** Options with the defaults filled in. What the tools actually read. */
export interface ResolvedEditOptions {
  readonly topological: boolean
  readonly allowVertexDelete: boolean
  readonly minVertices: number | undefined
  readonly handleSize: number
}

export interface EditApi {
  /** Start editing a feature: show its handles and activate `edit:vertex`. */
  edit(id: FeatureId): void

  /** End the session. Cancellable by a `before:edit:complete` listener. */
  stop(): void

  readonly editing: FeatureId | null

  /**
   * Cut a polygon with a line, in one undo step.
   *
   * Throws — rather than producing garbage — when the line does not fully cross the
   * feature. `line` is in 4326, like everything else that crosses the API.
   */
  split(id: FeatureId, line: LineString): void

  /** Union contiguous polygons into one, in one undo step. Throws if they are not contiguous. */
  merge(ids: readonly FeatureId[]): void

  /** Rotate about `pivot`, degrees clockwise. Default pivot: the centre of the selection's bounding box. */
  rotate(ids: readonly FeatureId[], degrees: number, pivot?: LngLat): void

  /** Uniform scale about `pivot`. */
  scale(ids: readonly FeatureId[], factor: number, pivot?: LngLat): void

  /** Translate by a planar offset, **in the working CRS's metres** — not in degrees. */
  move(ids: readonly FeatureId[], delta: ProjectedXY): void
}
