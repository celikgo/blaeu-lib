/**
 * `edit:transform` — move, rotate and scale through a bounding-box gizmo.
 *
 * Drag inside the box to move, a corner to scale, the stalk above it to rotate.
 * Every one of those is planar maths in the working CRS, in metres and degrees,
 * applied to the geometry **as it was when the drag began** — see
 * `EditController.applyTransform` for why that last part is not a detail.
 */

import {
  createId,
  type FeatureId,
  type LngLat,
  type PluginContext,
  type ProjectedXY,
  type Tool,
} from '@blaeu/core'
import type { EditController, TransformGesture } from '../controller.js'
import { ROTATE_HANDLE_OFFSET_FRACTION, type Handle } from '../handles.js'
import { planarBounds } from '../geometry.js'

type Mode = 'move' | 'rotate' | 'scale'

interface Gesture {
  readonly mode: Mode
  /**
   * The gesture id *and the geometries it started from*, handed to the controller on
   * every frame. Passing only the id and letting the controller re-read the store
   * would make each frame transform the previous frame's output — a 10 m drag over 10
   * frames would move the parcel 55 m.
   */
  readonly transform: TransformGesture
  readonly pivot: ProjectedXY
  /** Where the pointer was, in the plane, when the drag began. The reference for every frame. */
  readonly anchor: ProjectedXY
}

export function transformTool(ctx: PluginContext<unknown>, controller: EditController): Tool {
  let gesture: Gesture | null = null

  const boundsOf = (ids: readonly FeatureId[]): ReturnType<typeof planarBounds> => {
    if (ids.length === 0) return undefined
    const geometries = [...controller.originals(ids).values()]
    return planarBounds(geometries, controller.plane)
  }

  const gizmo = (): void => {
    const ids = controller.targets()
    const bounds = boundsOf(ids)
    if (bounds === undefined || ids.length === 0) {
      controller.handles.set([])
      controller.handles.setGuide(undefined)
      return
    }

    const plane = controller.plane
    const [minX, minY] = bounds.min
    const [maxX, maxY] = bounds.max
    const corners: ProjectedXY[] = [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ]
    const height = maxY - minY
    // The rotation stalk stands off the top edge by a fraction of the box, so it
    // stays grabbable whether the selection is a garden shed or a city block.
    const rotateAt: ProjectedXY = [
      bounds.centre[0],
      maxY + Math.max(height * ROTATE_HANDLE_OFFSET_FRACTION, 1),
    ]

    const target = ids[0]!
    const handles: Handle[] = corners.map((corner, index) => ({
      role: 'scale',
      target,
      part: 0,
      ring: 0,
      index,
      point: plane.inverse(corner),
      shared: false,
    }))
    handles.push({
      role: 'rotate',
      target,
      part: 0,
      ring: 0,
      index: 0,
      point: plane.inverse(rotateAt),
      shared: false,
    })

    const toPosition = (xy: ProjectedXY): [number, number] => {
      const [lng, lat] = plane.inverse(xy)
      return [lng, lat]
    }

    controller.handles.set(handles)
    // Two strands, not one: a single LineString would draw a spurious diagonal from
    // the box back to the rotation stalk, and a stray line on a cadastral map is a
    // line someone will eventually try to measure.
    controller.handles.setGuide({
      type: 'MultiLineString',
      coordinates: [
        [...corners, corners[0]!].map(toPosition),
        [[bounds.centre[0], maxY] as ProjectedXY, rotateAt].map(toPosition),
      ],
    })
  }

  const inside = (point: LngLat): boolean => {
    const bounds = boundsOf(controller.targets())
    if (bounds === undefined) return false

    const [x, y] = controller.plane.forward(point)
    return x >= bounds.min[0] && x <= bounds.max[0] && y >= bounds.min[1] && y <= bounds.max[1]
  }

  return {
    id: 'edit:transform',
    cursor: 'move',

    activate(): void {
      controller.setHandleRenderer(gizmo)
    },

    deactivate(): void {
      gesture = null
      controller.handles.setGuide(undefined)
      controller.setHandleRenderer(undefined)
    },

    onPointerDown(interaction): boolean {
      const ids = controller.targets()
      if (ids.length === 0) return false

      const handle = controller.handles.pick(interaction.screen, controller.options.handleSize)
      const mode: Mode | undefined =
        handle?.role === 'rotate'
          ? 'rotate'
          : handle?.role === 'scale'
            ? 'scale'
            : inside(interaction.lngLat)
              ? 'move'
              : undefined
      if (mode === undefined) return false

      const originals = controller.originals(ids)
      const pivot = controller.pivotFor([...originals.values()], undefined)
      if (pivot === undefined) return false

      gesture = {
        mode,
        transform: { id: createId(), originals },
        pivot,
        // The *pointer's* position, not the handle's: scaling by the ratio of two
        // pointer distances means the shape tracks the cursor exactly, with no jump
        // at the moment of grabbing.
        anchor: controller.plane.forward(interaction.lngLat),
      }

      // The features under the gesture are not snap targets while it runs. Otherwise a
      // scale grabs its own corner, the pointer is pulled back to it, the ratio of the
      // two pointer distances stays 1, and the parcel refuses to resize.
      ctx.tools.setDragging([...originals.keys()])
      return true
    },

    onPointerMove(interaction): boolean {
      if (gesture === null) return false
      const { mode, transform, pivot, anchor } = gesture
      const current = controller.plane.forward(interaction.lngLat)
      // The features the gesture grabbed, not whatever is selected now — and each
      // frame's transform is the *total* one since pointer-down, applied to the
      // geometry as it was then. Both halves of that are load-bearing.
      const ids = [...transform.originals.keys()]

      if (mode === 'move') {
        controller.move(ids, [current[0] - anchor[0], current[1] - anchor[1]], transform)
        return true
      }

      if (mode === 'rotate') {
        const before = Math.atan2(anchor[1] - pivot[1], anchor[0] - pivot[0])
        const after = Math.atan2(current[1] - pivot[1], current[0] - pivot[0])
        // Negated on the way out: `rotation()` takes degrees *clockwise* (grid
        // bearing, the surveyor's convention), and atan2 measures counter-clockwise.
        const degrees = (-(after - before) * 180) / Math.PI
        controller.rotate(ids, degrees, controller.plane.inverse(pivot), transform)
        return true
      }

      const grabbed = Math.hypot(anchor[0] - pivot[0], anchor[1] - pivot[1])
      const now = Math.hypot(current[0] - pivot[0], current[1] - pivot[1])
      // Grabbing exactly at the pivot gives no direction to scale along; ignoring the
      // frame is better than dividing by zero and collapsing the parcel to a point.
      if (grabbed <= 0) return true
      controller.scale(ids, now / grabbed, controller.plane.inverse(pivot), transform)
      return true
    },

    onPointerUp(): boolean {
      if (gesture === null) return false
      gesture = null
      ctx.tools.setDragging([])
      // Re-derive the box from where the features actually ended up, so the next
      // gesture starts from the truth rather than from the box we last drew.
      gizmo()
      return true
    },

    onKeyDown(interaction): boolean {
      if (interaction.key !== 'Escape') return false
      gesture = null
      ctx.tools.setDragging([])
      return true
    },
  }
}
