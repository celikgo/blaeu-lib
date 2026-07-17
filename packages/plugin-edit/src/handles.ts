/**
 * The handles: the little squares a user actually drags.
 *
 * They live in **store collections of their own** and are drawn by ordinary vector
 * layers, rather than being painted by some private renderer back-door. Three
 * things fall out of that, and all three matter:
 *
 * - they are hit-testable like anything else on the map;
 * - they are styled from theme tokens, so a preset restyles them without knowing
 *   this file exists;
 * - a plugin written later can *see* them (`store.collection('edit:vertices')`) —
 *   which is how a UI plugin could show a coordinate readout beside the vertex
 *   under the cursor without the edit plugin exposing anything for it.
 *
 * The writes go through the command bus like every other mutation (core invariant
 * 2), but they are `transient`: a handle appearing is not a user action, and
 * having to press Ctrl-Z eleven times to get past the handles of the parcel you
 * just clicked would be maddening.
 */

import type {
  Command,
  CommandContext,
  CollectionId,
  FeatureId,
  FeatureInput,
  BlaeuFeature,
  Geometry,
  LayerStyle,
  LngLat,
  PluginContext,
  ProjectedCrs,
  ScreenPoint,
  VertexRef,
} from '@blaeu/core'
import { cornerCount, eachRing, hasClosedRings, planarMidpoint, toLngLat } from './geometry.js'

/** Where vertex and gizmo handles live. Public, because a UI plugin may legitimately read them. */
export const VERTEX_COLLECTION: CollectionId = 'edit:vertices'
/** Where midpoint (insert) handles live. */
export const MIDPOINT_COLLECTION: CollectionId = 'edit:midpoints'
/** Where the transform box and the split preview live. */
export const GUIDE_COLLECTION: CollectionId = 'edit:guides'

/**
 * Our own scaffolding.
 *
 * Handles are real features in the store, which is what makes them hit-testable —
 * and which means the topology index sees them too. Every lookup that asks "what
 * else is on this corner?" must therefore exclude them, or dragging a parcel corner
 * would try to drag the handle drawn on top of it as if it were a neighbouring
 * parcel.
 */
export const HANDLE_COLLECTIONS: ReadonlySet<CollectionId> = new Set([
  VERTEX_COLLECTION,
  MIDPOINT_COLLECTION,
  GUIDE_COLLECTION,
])

export type HandleRole = 'vertex' | 'midpoint' | 'scale' | 'rotate'

/** A grabbable thing on the map, and enough addressing to know what grabbing it means. */
export interface Handle {
  readonly role: HandleRole
  readonly target: FeatureId
  readonly part: number
  readonly ring: number
  /** For a vertex: its index. For a midpoint: the index the inserted vertex will take. */
  readonly index: number
  readonly point: LngLat
  /** True when more than one feature has a vertex on this corner. Drives the "shared" styling. */
  readonly shared: boolean
}

/** A vertex handle wins a tie with the midpoint it sits near — you can always insert elsewhere. */
const PICK_PRIORITY: Record<HandleRole, number> = {
  vertex: 30,
  rotate: 20,
  scale: 20,
  midpoint: 10,
}

/** How far above the box's top edge the rotation handle floats, in metres of the working plane. */
export const ROTATE_HANDLE_OFFSET_FRACTION = 0.15

export class EditHandles {
  readonly #ctx: PluginContext<unknown>
  #handles: readonly Handle[] = []

  constructor(ctx: PluginContext<unknown>) {
    this.#ctx = ctx
  }

  /** Collections, layers and the theme subscription. Everything lands in `ctx.disposables`. */
  install(): void {
    const ctx = this.#ctx
    ctx.store.createCollection(GUIDE_COLLECTION)
    ctx.store.createCollection(MIDPOINT_COLLECTION)
    ctx.store.createCollection(VERTEX_COLLECTION)

    // Bottom to top: guides, then midpoints, then vertices. A vertex handle that a
    // midpoint can cover is a vertex the user cannot grab.
    const guides = ctx.layers.add({
      id: GUIDE_COLLECTION,
      type: 'vector',
      source: GUIDE_COLLECTION,
      style: this.#guideStyle(),
    })
    const midpoints = ctx.layers.add({
      id: MIDPOINT_COLLECTION,
      type: 'vector',
      source: MIDPOINT_COLLECTION,
      style: this.#midpointStyle(),
    })
    const vertices = ctx.layers.add({
      id: VERTEX_COLLECTION,
      type: 'vector',
      source: VERTEX_COLLECTION,
      style: this.#vertexStyle(),
    })

    ctx.disposables.add(guides)
    ctx.disposables.add(midpoints)
    ctx.disposables.add(vertices)

    ctx.disposables.add(
      ctx.theme.onChange(() => {
        guides.setStyle(this.#guideStyle())
        midpoints.setStyle(this.#midpointStyle())
        vertices.setStyle(this.#vertexStyle())
      }),
    )

    // The collections outlive the layers by a moment during teardown; drop them so a
    // removed plugin leaves a store with nothing of its own in it.
    ctx.disposables.addFn(() => {
      this.clear()
      ctx.store.removeCollection(VERTEX_COLLECTION)
      ctx.store.removeCollection(MIDPOINT_COLLECTION)
      ctx.store.removeCollection(GUIDE_COLLECTION)
    })
  }

  /** Everything currently grabbable. */
  handles(): readonly Handle[] {
    return this.#handles
  }

  set(handles: readonly Handle[]): void {
    this.#handles = handles

    const vertices: FeatureInput[] = []
    const midpoints: FeatureInput[] = []
    for (const handle of handles) {
      const feature = toFeature(handle)
      if (handle.role === 'midpoint') midpoints.push(feature)
      else vertices.push(feature)
    }

    this.#write(VERTEX_COLLECTION, vertices)
    this.#write(MIDPOINT_COLLECTION, midpoints)
  }

  /** The transform box, or the split line being drawn. `undefined` clears it. */
  setGuide(geometry: Geometry | undefined): void {
    this.#write(
      GUIDE_COLLECTION,
      geometry === undefined
        ? []
        : [
            {
              id: 'edit:guide',
              geometry,
              properties: { role: 'guide' },
              meta: { snappable: false },
            },
          ],
    )
  }

  clear(): void {
    this.#handles = []
    this.#write(VERTEX_COLLECTION, [])
    this.#write(MIDPOINT_COLLECTION, [])
    this.#write(GUIDE_COLLECTION, [])
  }

  /**
   * The handle under the pointer, if any.
   *
   * Picked in **screen space**, because "close" to a user means pixels: a 10 px grab
   * radius is a fingertip at any zoom, whereas a metric one would be un-grabbable at
   * zoom 12 and cover the whole parcel at zoom 22.
   */
  pick(screen: ScreenPoint, tolerancePx: number): Handle | undefined {
    let best: Handle | undefined
    let bestScore = -Infinity

    for (const handle of this.#handles) {
      const at = this.#ctx.renderer.project(handle.point)
      const distance = Math.hypot(at.x - screen.x, at.y - screen.y)
      if (distance > tolerancePx) continue

      // Role first, distance second: a vertex sitting almost on top of a midpoint
      // must still be the thing you grab, or a corner becomes undraggable.
      const score = PICK_PRIORITY[handle.role] * 1000 - distance
      if (score > bestScore) {
        bestScore = score
        best = handle
      }
    }
    return best
  }

  #write(collection: CollectionId, features: readonly FeatureInput[]): void {
    const existing = this.#ctx.store.collection(collection).all()
    if (existing.length === 0 && features.length === 0) return
    this.#ctx.commands.dispatch(new ReplaceHandlesCommand(collection, features))
  }

  #vertexStyle(): LayerStyle {
    const color = this.#ctx.theme.token('color')
    const size = this.#ctx.theme.token('size')
    return {
      circle: {
        color: color.vertex,
        radius: size.vertexRadius,
        strokeColor: color.vertexActive,
        strokeWidth: 2,
      },
    }
  }

  #midpointStyle(): LayerStyle {
    const color = this.#ctx.theme.token('color')
    const size = this.#ctx.theme.token('size')
    return {
      circle: {
        color: color.midpoint,
        radius: size.midpointRadius,
        strokeColor: color.vertexActive,
        strokeWidth: 1,
      },
    }
  }

  #guideStyle(): LayerStyle {
    const color = this.#ctx.theme.token('color')
    const size = this.#ctx.theme.token('size')
    return {
      line: { color: color.guide, width: size.lineWidth, opacity: 0.9, dasharray: [2, 2] },
      fill: { color: color.guide, opacity: 0.05 },
    }
  }
}

/**
 * Every vertex and midpoint of one feature.
 *
 * Midpoints are computed **in the plane**, not by averaging degrees: the midpoint
 * of two longitudes is not the middle of the edge, and inserting a vertex there
 * puts a visible kink in a boundary the surveyor drew straight.
 */
export function handlesFor(
  feature: BlaeuFeature,
  plane: ProjectedCrs,
  isShared: (point: LngLat) => boolean,
): Handle[] {
  const handles: Handle[] = []
  const closed = hasClosedRings(feature.geometry)

  eachRing(feature.geometry, (part, ring, positions) => {
    const corners = cornerCount(positions, closed)

    for (let i = 0; i < corners; i++) {
      const point = toLngLat(positions[i]!)
      handles.push({
        role: 'vertex',
        target: feature.id,
        part,
        ring,
        index: i,
        point,
        shared: isShared(point),
      })
    }

    // Segments: a closed ring's last corner joins back to the first (the closing
    // coordinate is already there, so `positions.length - 1` counts it exactly once).
    const segments = closed ? corners : corners - 1
    for (let i = 0; i < segments; i++) {
      const a = toLngLat(positions[i]!)
      const b = toLngLat(positions[(i + 1) % positions.length]!)
      handles.push({
        role: 'midpoint',
        target: feature.id,
        part,
        ring,
        // The index the new vertex will take once inserted — so the tool can start
        // dragging it immediately, without re-deriving anything.
        index: i + 1,
        point: planarMidpoint(a, b, plane),
        shared: false,
      })
    }
  })

  return handles
}

/** The {@link VertexRef} a vertex handle addresses. */
export function refOf(handle: Handle): VertexRef {
  return { feature: handle.target, part: handle.part, ring: handle.ring, index: handle.index }
}

function toFeature(handle: Handle): FeatureInput {
  return {
    id: `${handle.role}:${handle.target}:${handle.part}:${handle.ring}:${handle.index}`,
    geometry: { type: 'Point', coordinates: [handle.point[0], handle.point[1]] },
    properties: {
      role: handle.role,
      target: handle.target,
      part: handle.part,
      ring: handle.ring,
      index: handle.index,
      shared: handle.shared,
    },
    // Scaffolding, not geometry. A handle sits exactly on the vertex it draws, so a
    // snapping middleware would offer the dragged vertex its own handle as a target and
    // pin it in place. `snappable: false` is a core flag, so this plugin says what the
    // feature *is* and never has to know who is listening.
    meta: { snappable: false },
  }
}

/**
 * Swaps the entire contents of a handle collection.
 *
 * `transient`, so it never reaches the undo stack — but it still implements `undo`
 * honestly, because a transaction that throws rolls the store back through it and
 * a lying `undo` would strand handles for a parcel that no longer exists.
 */
class ReplaceHandlesCommand implements Command<void> {
  readonly type = 'edit:handles'
  readonly label = 'Edit handles'
  readonly transient = true

  readonly #collection: CollectionId
  readonly #features: readonly FeatureInput[]
  #removed: readonly BlaeuFeature[] = []
  #added: readonly FeatureId[] = []

  constructor(collection: CollectionId, features: readonly FeatureInput[]) {
    this.#collection = collection
    this.#features = features
  }

  execute(ctx: CommandContext): void {
    const existing = ctx.store.collection(this.#collection).all()
    if (existing.length > 0) {
      this.#removed = ctx.store._remove(existing.map((feature) => feature.id))
    }
    if (this.#features.length > 0) {
      this.#added = ctx.store._add(this.#collection, this.#features).map((feature) => feature.id)
    }
  }

  undo(ctx: CommandContext): void {
    if (this.#added.length > 0) ctx.store._remove(this.#added)
    if (this.#removed.length > 0) ctx.store._add(this.#collection, this.#removed)
  }
}
