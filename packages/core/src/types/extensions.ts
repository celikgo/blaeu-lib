import type { Bbox, CollectionId, Disposable, FeatureId, LngLat, ScreenPoint } from './common.js'
import type { EdgeRef, VertexRef } from './feature.js'
import type { InteractionContext } from './pipeline.js'
import type { LayerStyle } from './renderer.js'
import type { ThemeTokens } from './theme.js'

/* ========================================================================= */
/* Tools — the interactive modes                                             */
/* ========================================================================= */

/**
 * An interactive mode: draw-polygon, edit-vertex, measure-distance, select-lasso.
 *
 * Exactly one **primary** tool is active at a time, which is what makes a map
 * feel coherent rather than modal-soup. Ambient behaviour that should always run
 * (hover highlighting, the snap indicator) is not a tool — it's middleware.
 *
 * A tool receives events *after* the interaction pipeline, which means the
 * position it reads has already been snapped, grid-locked and constrained. This
 * is why a tool implementation is usually 40 lines: all the hard geometry
 * happened upstream.
 */
export interface Tool {
  readonly id: string
  /** The cursor while this tool is active. */
  readonly cursor?: string

  activate(): void
  deactivate(): void

  /** Return `true` to mark the event handled. */
  onPointerDown?(ctx: InteractionContext): boolean | void
  onPointerMove?(ctx: InteractionContext): boolean | void
  onPointerUp?(ctx: InteractionContext): boolean | void
  onClick?(ctx: InteractionContext): boolean | void
  onDblClick?(ctx: InteractionContext): boolean | void
  onKeyDown?(ctx: InteractionContext): boolean | void
}

export interface ToolManager {
  register(id: string, tool: Tool): Disposable
  activate(id: string): void
  /** Return to the idle tool (usually pan/select). */
  deactivate(): void
  readonly active: string | null
  list(): readonly string[]

  /**
   * Declare the features the active tool is currently dragging, for the duration of
   * one gesture. Call with `[]` on pointer-up.
   *
   * **This is what stops a dragged vertex from snapping to itself**, and it is in the
   * kernel — rather than being a conversation between the edit plugin and the snap
   * plugin — for a reason worth stating.
   *
   * A snapping middleware sees a pointer near a parcel corner and helpfully pulls it
   * onto that corner. During a drag *of that very corner*, that is a disaster: the
   * corner is under the cursor, so the pointer snaps back onto it, the tool is told the
   * vertex has not moved, and the vertex never moves again. Every drag shorter than the
   * snap tolerance silently becomes a no-op. The same is true of the vertex handles and
   * the transform box, which are real features in the store sitting exactly where the
   * cursor is.
   *
   * The tool is the only thing that knows what is in play. But it must not have to know
   * *who is listening* — the edit plugin has never heard of the snap plugin and must not
   * start now, or the plugin-first architecture is a fiction. So the tool states the
   * fact, on a kernel type, and any middleware that cares can read it: snapping today, a
   * grid lock or a constraint solver tomorrow, neither of which the edit plugin will ever
   * import either.
   */
  setDragging(ids: readonly FeatureId[]): void

  /** What the active tool declared it is dragging. Empty between gestures. */
  readonly dragging: readonly FeatureId[]
}

/* ========================================================================= */
/* Layers — pluggable layer *types*                                          */
/* ========================================================================= */

/**
 * A layer style that is a *function of the theme* rather than a fixed value.
 *
 * A preset that writes `style: (t) => ({ line: { color: t.color.accent } })` gets a
 * parcel outline that follows a theme change — switch to a dark theme and the line
 * re-tints with everything else, no subscription in the preset. The layer manager
 * resolves the function against the live tokens and re-invokes it on every theme
 * change, which is the only way a *declarative* layer (added as data, not by a plugin
 * with its own `onChange`) can track the palette.
 */
export type ThemeStyleFn = (tokens: ThemeTokens) => LayerStyle

export interface LayerSpec {
  readonly id: string
  /** A registered layer type. Core ships `vector` and `raster`; plugins add more. */
  readonly type: string
  readonly source?: CollectionId
  /**
   * A fixed style, or a function of the theme tokens. A function is re-evaluated on
   * every theme change, so a declarative layer can follow the palette without the
   * caller wiring `theme.onChange` themselves.
   */
  readonly style?: LayerStyle | ThemeStyleFn
  readonly visible?: boolean
  /** Insert beneath this layer id. */
  readonly beforeId?: string
  /** Type-specific configuration, validated by the layer type itself. */
  readonly config?: Record<string, unknown>
}

export interface LayerInstance extends Disposable {
  readonly id: string
  readonly type: string
  setVisible(visible: boolean): void
  setStyle(style: LayerStyle): void
}

/**
 * What a layer *type* receives: a spec whose style is already a concrete
 * {@link LayerStyle}.
 *
 * The public {@link LayerSpec} lets `style` be a function of the theme, but the layer
 * manager resolves that function against the live tokens before it ever reaches a
 * type — so a type author writes against a plain style and never has to know the theme
 * exists. The manager is the single place that turns a `ThemeStyleFn` into pixels.
 */
export interface ResolvedLayerSpec extends Omit<LayerSpec, 'style'> {
  readonly style?: LayerStyle
}

/**
 * Registering a *layer type* — not a layer — is what lets a plugin add a whole
 * new rendering category without the core knowing about it.
 *
 * A deck.gl plugin registers `type: 'deckgl'`. A game plugin registers
 * `'tile-grid'` and `'fog-of-war'`. An analytics plugin registers `'heatmap'`.
 * All of them are then usable through the same `map.layers.add({ type })` call,
 * and all of them compose with everything else.
 */
export interface LayerTypeDef<TConfig = Record<string, unknown>> {
  readonly type: string
  create(spec: ResolvedLayerSpec & { config?: TConfig }): LayerInstance
}

export interface LayerManager {
  registerType<T>(def: LayerTypeDef<T>): Disposable
  add(spec: LayerSpec): LayerInstance
  remove(id: string): void
  get(id: string): LayerInstance | undefined
  list(): readonly LayerInstance[]
  /** Reorder. `beforeId === undefined` moves it to the top. */
  move(id: string, beforeId?: string): void
}

/* ========================================================================= */
/* Snapping — pluggable snap targets                                         */
/* ========================================================================= */

export type SnapKind =
  | 'vertex'
  | 'edge'
  | 'midpoint'
  | 'intersection'
  | 'grid'
  | 'extension'
  | 'perpendicular'
  | 'parallel'
  | 'center'
  | (string & {}) // plugins may invent their own kinds

/** One candidate position the pointer could snap to. */
export interface SnapCandidate {
  readonly kind: SnapKind
  readonly point: LngLat
  /** Distance from the raw pointer, in **screen pixels** — that's what "close" means to a user. */
  readonly distancePx: number
  /**
   * Tie-break when two candidates are equidistant. Higher wins.
   *
   * The ordering matters more than it sounds: a vertex must outrank the edge it
   * sits on, or you can never snap to a corner — the edge is always exactly as
   * close. Convention: vertex 100 > intersection 90 > midpoint 80 > edge 70 >
   * grid 10.
   */
  readonly priority: number
  readonly feature?: FeatureId
  readonly vertex?: VertexRef
  readonly edge?: EdgeRef
  /** Shown in the snap indicator tooltip, already localised. */
  readonly hint?: string
}

/** What the snap engine settled on. Written to `InteractionContext.snap`. */
export interface SnapResult {
  readonly candidate: SnapCandidate
  /** Every candidate considered, best first. A debug/UI affordance ("cycle snap with Tab"). */
  readonly alternatives: readonly SnapCandidate[]
}

/**
 * A source of snap targets.
 *
 * This is the extension point that makes snapping open-ended. Core snapping
 * covers vertices, edges, midpoints, intersections and grids. But a domain has
 * its own idea of "significant point": a cadastre plugin snaps to a *parcel
 * corner* specifically, a utilities plugin snaps to a pipe junction, a game
 * plugin snaps to a hex centre.
 *
 * Implement this, register it, and every tool in the product — including tools
 * you didn't write — snaps to your targets.
 */
export interface SnapProvider {
  readonly id: string
  /** Higher-priority providers are queried first and win ties. */
  readonly priority?: number

  /**
   * Candidates near `point` within `tolerancePx`.
   *
   * Called on **every pointer move**, so it must be fast: query the spatial index,
   * don't scan. Returning more than a handful of candidates is a smell — the
   * engine only shows the winner.
   */
  query(point: LngLat, tolerancePx: number, ctx: SnapQueryContext): readonly SnapCandidate[]
}

export interface SnapQueryContext {
  readonly project: (lngLat: LngLat) => ScreenPoint
  readonly unproject: (p: ScreenPoint) => LngLat
  /** Bbox of the tolerance circle, precomputed — use it to hit the spatial index. */
  readonly bbox: Bbox
  /** Features to ignore — the one being drawn or dragged, so it can't snap to itself. */
  readonly exclude: ReadonlySet<FeatureId>
  /** Vertices already committed in the current gesture. Lets you snap to your own first point to close a ring. */
  readonly inProgress: readonly LngLat[]
}
