import { describe, expect, it } from 'vitest'
import {
  ANKARA,
  createTestMap,
  distanceMetres,
  expectWithinMetres,
  offsetMetres,
  parcelFixture,
  sharedEdgeParcels,
  type TestMap,
} from '@fleximap/core/testing'
import type { Command, FeatureId, FlexiFeature, LngLat, Polygon } from '@fleximap/core'

import { editPlugin } from './index.js'
import { MoveVerticesCommand } from './commands.js'

const PARCEL_W = 50
const PARCEL_H = 40

/** The four corners of `parcelFixture()`, in ring order. */
const SW = ANKARA
const SE = offsetMetres(ANKARA, PARCEL_W, 0)
const NE = offsetMetres(ANKARA, PARCEL_W, PARCEL_H)

async function mapWithParcel(options = {}): Promise<TestMap> {
  return createTestMap({
    plugins: [editPlugin(options)],
    features: { parcels: [parcelFixture('p')] },
  })
}

function ring(map: TestMap, id: FeatureId): readonly LngLat[] {
  const feature = map.store.find(id)
  if (feature === undefined) throw new Error(`no feature ${id}`)
  const polygon = feature.geometry as Polygon
  return (polygon.coordinates[0] ?? []).map((position) => [position[0]!, position[1]!] as LngLat)
}

/** Corners, closing coordinate excluded. */
function corners(map: TestMap, id: FeatureId): readonly LngLat[] {
  return ring(map, id).slice(0, -1)
}

/** The corner nearest `point` — ring order is normalised on ingest, so never assume an index. */
function cornerNear(map: TestMap, id: FeatureId, point: LngLat): LngLat {
  const found = [...corners(map, id)].sort(
    (a, b) => distanceMetres(a, point) - distanceMetres(b, point),
  )[0]
  if (found === undefined) throw new Error('no corners')
  return found
}

describe('editPlugin — degradation (the plugin owes this one)', () => {
  it('edits geometry with no snap, select or history plugin installed', async () => {
    const map = await mapWithParcel()
    expect(map.plugins.has('snap')).toBe(false)
    expect(map.plugins.has('select')).toBe(false)
    expect(map.plugins.has('history')).toBe(false)

    map.plugin('edit').edit('p')
    expect(map.tools.active).toBe('edit:vertex')

    const target = offsetMetres(SE, 5, 3)
    map.test.drag(cornerNear(map, 'p', SE), target, { steps: 10 })

    expectWithinMetres(cornerNear(map, 'p', target), target, 0.002)
    await map.destroy()
  })

  it('still transforms without a select plugin, using the edited feature', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')

    const before = map.crs.area(map.store.find('p')!.geometry)
    map.plugin('edit').scale(['p'], 2)
    const after = map.crs.area(map.store.find('p')!.geometry)

    // Uniform scale by 2 quadruples the area, in the plane, in m² — not "about four
    // times", which is what a spherical area would give you.
    expect(after / before).toBeCloseTo(4, 3)
    await map.destroy()
  })
})

describe('editPlugin — teardown (the plugin owes this one)', () => {
  it('leaks nothing on removal', async () => {
    const map = await createTestMap({ features: { parcels: [parcelFixture('p')] } })
    const before = map.debug.snapshot()

    await map.use(editPlugin())
    map.plugin('edit').edit('p')
    // Handles are real features, in real layers, with real listeners — so this is a
    // genuine leak test rather than one for a plugin that registered nothing.
    expect(map.store.collection('edit:vertices').size).toBeGreaterThan(0)

    await map.remove('edit')
    const after = map.debug.snapshot()

    expect(after['listeners']).toBe(before['listeners'])
    expect(after['middleware']).toBe(before['middleware'])
    expect(after['layers']).toBe(before['layers'])
    expect(after['plugins']).toBe(before['plugins'])
    // The handle collections are gone, and the parcel is untouched.
    expect(after['features']).toBe(before['features'])
    expect(map.store.collections()).not.toContain('edit:vertices')
    expect(map.tools.list()).not.toContain('edit:vertex')

    await map.destroy()
  })
})

describe('editPlugin — undo round-trip (the plugin owes this one)', () => {
  it('restores deep equality after every geometry command', async () => {
    const map = await mapWithParcel()
    const corner = cornerNear(map, 'p', SE)
    const before = map.store.snapshot()

    const command = new MoveVerticesCommand(
      map.store.topology.at(corner).slice(),
      corner,
      offsetMetres(corner, 4, 4),
      { gesture: 'g1' },
    )
    map.commands.dispatch(command)
    expect(map.store.snapshot()).not.toEqual(before)

    map.commands._apply(command, 'undo')
    expect(map.store.snapshot()).toEqual(before)

    // And redo lands back on the edit, byte for byte — a redo that re-derives its
    // result would bump `version` a second time and never compare equal again.
    map.commands._apply(command, 'redo')
    const redone = map.store.snapshot()
    map.commands._apply(command, 'undo')
    map.commands._apply(command, 'redo')
    expect(map.store.snapshot()).toEqual(redone)

    await map.destroy()
  })

  it('round-trips an insert and a delete', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')
    const before = map.store.snapshot()

    const captured: Command[] = []
    const off = map.commands.onDidExecute((command) => captured.push(command))

    // Grab the midpoint of the south edge and pull it out — insert, then drag.
    const midpoint = midpointBetween(map, SW, SE)
    map.test.drag(midpoint, offsetMetres(midpoint, 0, -6), { steps: 4 })
    off.dispose()

    expect(corners(map, 'p')).toHaveLength(5)

    for (let i = captured.length - 1; i >= 0; i--) map.commands._apply(captured[i]!, 'undo')
    expect(corners(map, 'p')).toHaveLength(4)
    expect(map.store.collection('parcels').all()).toEqual(
      (before.collections['parcels'] ?? []).slice(),
    )

    await map.destroy()
  })
})

describe('editPlugin — topological editing', () => {
  it('drags a shared corner in both parcels, in one command', async () => {
    const map = await createTestMap({
      plugins: [editPlugin({ topological: true })],
      features: { parcels: sharedEdgeParcels() },
    })

    const shared = offsetMetres(ANKARA, PARCEL_W, 0)
    expect(map.store.topology.featuresAt(shared)).toHaveLength(2)

    const commands: Command[] = []
    const off = map.commands.onDidExecute((command) => commands.push(command))

    map.plugin('edit').edit('parcel-left')
    const target = offsetMetres(shared, 3, 2)
    map.test.drag(cornerNear(map, 'parcel-left', shared), target, { steps: 8 })
    off.dispose()

    // Both parcels followed the corner. If one of them had not, two adjacent parcels
    // would now overlap by 3 m² — which is a boundary dispute, not a redraw.
    expectWithinMetres(cornerNear(map, 'parcel-left', target), target, 0.002)
    expectWithinMetres(cornerNear(map, 'parcel-right', target), target, 0.002)

    const moves = commands.filter((command) => command instanceof MoveVerticesCommand)
    expect(moves.length).toBeGreaterThan(0)
    for (const move of moves) {
      expect(new Set(move.refs.map((ref) => ref.feature))).toEqual(
        new Set(['parcel-left', 'parcel-right']),
      )
    }

    await map.destroy()
  })

  it('leaves the neighbour alone when topological editing is off', async () => {
    const map = await createTestMap({
      plugins: [editPlugin()],
      features: { parcels: sharedEdgeParcels() },
    })

    const shared = offsetMetres(ANKARA, PARCEL_W, 0)
    map.plugin('edit').edit('parcel-left')
    const target = offsetMetres(shared, 3, 2)
    map.test.drag(cornerNear(map, 'parcel-left', shared), target, { steps: 8 })

    expectWithinMetres(cornerNear(map, 'parcel-left', target), target, 0.002)
    expectWithinMetres(cornerNear(map, 'parcel-right', shared), shared, 0.001)

    await map.destroy()
  })

  it('inserts a vertex into every feature sharing the edge', async () => {
    const map = await createTestMap({
      plugins: [editPlugin({ topological: true })],
      features: { parcels: sharedEdgeParcels() },
    })

    map.plugin('edit').edit('parcel-left')
    const midpoint = midpointBetween(
      map,
      offsetMetres(ANKARA, PARCEL_W, 0),
      offsetMetres(ANKARA, PARCEL_W, PARCEL_H),
    )
    map.test.pointerDown(midpoint)
    map.test.pointerUp(midpoint)

    // The shared boundary now has the same number of corners on both sides. It is the
    // moment this diverges that a "shared" edge stops being one.
    expect(corners(map, 'parcel-left')).toHaveLength(5)
    expect(corners(map, 'parcel-right')).toHaveLength(5)

    await map.destroy()
  })
})

describe('editPlugin — float accumulation', () => {
  it('lands a 200-frame drag exactly where it was dropped', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')

    const target = offsetMetres(NE, 7.5, -3.25)
    map.test.drag(cornerNear(map, 'p', NE), target, { steps: 200 })

    // 1 mm is the working CRS's precision grid: land within it and the drag has not
    // accumulated error, because a chain of 200 incremental deltas would not.
    expectWithinMetres(cornerNear(map, 'p', target), target, 0.0015)
    await map.destroy()
  })
})

describe('editPlugin — coalescing', () => {
  it('merges a whole drag into one undo step, and only within one gesture', async () => {
    const map = await mapWithParcel()
    const corner = cornerNear(map, 'p', SE)
    const refs = map.store.topology.at(corner).slice()

    const first = new MoveVerticesCommand(refs, corner, offsetMetres(corner, 1, 0), {
      gesture: 'drag-1',
    })
    const second = new MoveVerticesCommand(
      refs,
      offsetMetres(corner, 1, 0),
      offsetMetres(corner, 2, 0),
      {
        gesture: 'drag-1',
      },
    )
    const other = new MoveVerticesCommand(refs, corner, offsetMetres(corner, 3, 0), {
      gesture: 'drag-2',
    })

    map.commands.dispatch(first)
    map.commands.dispatch(second)

    const merged = second.coalesceWith(first)
    expect(merged).toBeInstanceOf(MoveVerticesCommand)
    // The merged command spans the gesture: from where the finger went down to where
    // it came up. One Ctrl-Z, not two hundred.
    expect((merged as MoveVerticesCommand).from).toEqual(corner)
    expect((merged as MoveVerticesCommand).to).toEqual(offsetMetres(corner, 2, 0))

    expect(other.coalesceWith(second)).toBeNull()

    await map.destroy()
  })

  it('an undone coalesced drag restores the pre-drag geometry', async () => {
    const map = await mapWithParcel()
    const corner = cornerNear(map, 'p', SE)
    const refs = map.store.topology.at(corner).slice()
    const before = map.store.snapshot()

    const first = new MoveVerticesCommand(refs, corner, offsetMetres(corner, 1, 0), {
      gesture: 'g',
    })
    map.commands.dispatch(first)
    const second = new MoveVerticesCommand(
      refs,
      offsetMetres(corner, 1, 0),
      offsetMetres(corner, 2, 0),
      {
        gesture: 'g',
      },
    )
    map.commands.dispatch(second)

    const merged = second.coalesceWith(first)!
    map.commands._apply(merged, 'undo')
    expect(map.store.snapshot()).toEqual(before)

    await map.destroy()
  })
})

describe('editPlugin — vertex delete', () => {
  it('deletes a corner on Alt-click', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')

    const corner = cornerNear(map, 'p', NE)
    map.test.pointerDown(corner, { alt: true })

    expect(corners(map, 'p')).toHaveLength(3)
    await map.destroy()
  })

  it('refuses to take a polygon below three corners, and says why', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')

    const errors: Error[] = []
    map.events.on('map:error', (event) => errors.push(event.payload.error))

    map.test.pointerDown(cornerNear(map, 'p', NE), { alt: true })
    expect(corners(map, 'p')).toHaveLength(3)

    map.test.pointerDown(cornerNear(map, 'p', SE), { alt: true })
    // Still a triangle: the refusal is reported, not enacted, and it does not take the
    // interaction loop down with it.
    expect(corners(map, 'p')).toHaveLength(3)
    expect(errors.at(-1)?.message).toContain('needs at least 3')

    await map.destroy()
  })

  it('honours allowVertexDelete: false', async () => {
    const map = await mapWithParcel({ allowVertexDelete: false })
    map.plugin('edit').edit('p')

    map.test.pointerDown(cornerNear(map, 'p', NE), { alt: true })
    expect(corners(map, 'p')).toHaveLength(4)

    await map.destroy()
  })
})

describe('editPlugin — transforms', () => {
  it('rotates in the plane, preserving area and moving the corners', async () => {
    const map = await mapWithParcel()
    const before = map.store.find('p')!
    const area = map.crs.area(before.geometry)

    map.plugin('edit').rotate(['p'], 90)

    const after = map.store.find('p')!
    // A rotation is an isometry in the projected plane. If the area moved by more than
    // the precision grid can explain, the maths happened on degrees — where a
    // "rotation" also shears, and the error would be percent, not parts per million.
    // (The residue that *is* here is the store quantising the rotated corners to the
    // millimetre on ingest: ~perimeter × 1 mm, and no more.)
    const drift = Math.abs(map.crs.area(after.geometry) - area) / area
    expect(drift).toBeLessThan(1e-4)

    const rotated = corners(map, 'p')
    const original = (before.geometry as Polygon).coordinates[0]!.slice(0, -1)
    expect(rotated.some((c) => distanceMetres(c, [original[0]![0]!, original[0]![1]!]) > 1)).toBe(
      true,
    )

    await map.destroy()
  })

  it('moves by metres in the working plane, not by degrees', async () => {
    const map = await mapWithParcel()
    const before = cornerNear(map, 'p', SW)

    map.plugin('edit').move(['p'], [10, 0])

    const after = cornerNear(map, 'p', offsetMetres(before, 10, 0))
    expect(map.crs.distance(before, after)).toBeCloseTo(10, 2)
    await map.destroy()
  })

  it('rejects a scale factor of zero rather than collapsing the parcel', async () => {
    const map = await mapWithParcel()
    expect(() => map.plugin('edit').scale(['p'], 0)).toThrow(/positive, finite/)
    await map.destroy()
  })
})

describe('editPlugin — the transform gizmo does not accumulate', () => {
  /** Start the gizmo on the parcel and hand back the pre-drag corners. */
  async function withGizmo(): Promise<{ map: TestMap; before: readonly LngLat[] }> {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')
    map.tools.activate('edit:transform')
    return { map, before: corners(map, 'p') }
  }

  it('moves the parcel by the drag delta, whatever the frame count', async () => {
    // The regression this guards: every frame used to be applied to the *previous*
    // frame's output rather than to the geometry the drag started from, so a 10 m drag
    // over 10 frames moved the parcel 1+2+…+10 = 55 m. It renders perfectly, and it is
    // 45 m of somebody else's land.
    for (const steps of [1, 10, 60]) {
      const { map, before } = await withGizmo()
      const from = offsetMetres(ANKARA, PARCEL_W / 2, PARCEL_H / 2)
      map.test.drag(from, offsetMetres(from, 10, 0), { steps })

      for (const corner of before) {
        expectWithinMetres(
          cornerNear(map, 'p', offsetMetres(corner, 10, 0)),
          offsetMetres(corner, 10, 0),
          0.002,
        )
      }
      await map.destroy()
    }
  })

  it('rotates by the angle the pointer swept, not by the sum of every frame', async () => {
    const { map, before } = await withGizmo()
    const area = map.crs.area(map.store.find('p')!.geometry)
    const plane = map.crs.working
    const pivot = plane.forward(centreOf(before, map))

    // The parcel's own planar bounding box — a quarter turn about the centre transposes
    // it, whatever shape the fixture happens to be.
    const wasWide = spanMetres(before, map, 'x')
    const wasTall = spanMetres(before, map, 'y')

    // Grab the rotate handle and sweep it a quarter turn about the pivot, in 20 frames.
    const handle = rotateHandle(map)
    const grabbed = plane.forward(handle)
    const radius = Math.hypot(grabbed[0] - pivot[0], grabbed[1] - pivot[1])
    const start = Math.atan2(grabbed[1] - pivot[1], grabbed[0] - pivot[0])
    const end = start + Math.PI / 2
    const to = plane.inverse([pivot[0] + radius * Math.cos(end), pivot[1] + radius * Math.sin(end)])

    map.test.drag(handle, to, { steps: 20 })

    // One quarter turn, not twenty of them wound up like a clock spring. A rotation is
    // an isometry, so the area is unchanged; and the bounding box has *transposed* —
    // which pins the angle to 90°, where "area preserved" alone would accept any
    // multiple of a full turn.
    const after = corners(map, 'p')
    expect(map.crs.area(map.store.find('p')!.geometry) / area).toBeCloseTo(1, 3)
    expectWithinMillimetres(spanMetres(after, map, 'x'), wasTall, 5)
    expectWithinMillimetres(spanMetres(after, map, 'y'), wasWide, 5)

    await map.destroy()
  })

  it('scales by the ratio the pointer travelled, not exponentially', async () => {
    const { map } = await withGizmo()
    const area = map.crs.area(map.store.find('p')!.geometry)
    const plane = map.crs.working

    // Grab a corner of the gizmo box and pull it to twice its distance from the pivot.
    const scaleHandle = [...map.store.collection('edit:vertices')]
      .filter((feature) => feature.properties['role'] === 'scale')
      .map((feature) => {
        const point = feature.geometry as { coordinates: number[] }
        return [point.coordinates[0]!, point.coordinates[1]!] as LngLat
      })[0]
    if (scaleHandle === undefined) throw new Error('no scale handles')

    const pivot = plane.forward(centreOf(corners(map, 'p'), map))
    const grabbed = plane.forward(scaleHandle)
    const to = plane.inverse([
      pivot[0] + (grabbed[0] - pivot[0]) * 2,
      pivot[1] + (grabbed[1] - pivot[1]) * 2,
    ])

    map.test.drag(scaleHandle, to, { steps: 20 })

    // Scale by 2 ⇒ area × 4. Accumulated over 20 frames it would have been 2^20-ish,
    // and the parcel would cover central Anatolia.
    expect(map.crs.area(map.store.find('p')!.geometry) / area).toBeCloseTo(4, 2)

    await map.destroy()
  })
})

/** Two planar lengths agree to within `tolerance` millimetres. */
function expectWithinMillimetres(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected) * 1000).toBeLessThan(tolerance)
}

/** Centre of the bounding box, in the working plane — the pivot the gizmo uses. */
function centreOf(points: readonly LngLat[], map: TestMap): LngLat {
  const plane = map.crs.working
  const xs = points.map((p) => plane.forward(p)[0])
  const ys = points.map((p) => plane.forward(p)[1])
  return plane.inverse([
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  ])
}

/** Extent of the corners along one planar axis, in metres. */
function spanMetres(points: readonly LngLat[], map: TestMap, axis: 'x' | 'y'): number {
  const plane = map.crs.working
  const values = points.map((p) => plane.forward(p)[axis === 'x' ? 0 : 1])
  return Math.max(...values) - Math.min(...values)
}

/** The gizmo's rotation stalk. */
function rotateHandle(map: TestMap): LngLat {
  const found = [...map.store.collection('edit:vertices')]
    .filter((feature) => feature.properties['role'] === 'rotate')
    .map((feature) => {
      const point = feature.geometry as { coordinates: number[] }
      return [point.coordinates[0]!, point.coordinates[1]!] as LngLat
    })[0]
  if (found === undefined) throw new Error('no rotate handle')
  return found
}

describe('editPlugin — split', () => {
  it('cuts a parcel in two, preserving the total area', async () => {
    const map = await mapWithParcel()
    const area = map.crs.area(map.store.find('p')!.geometry)

    const parts: FlexiFeature[] = []
    map.events.on('edit:split', (event) => parts.push(...event.payload.parts))

    // A cut that starts outside the parcel and ends outside it — the only kind that
    // actually separates one.
    await map.plugin('edit').split('p', {
      type: 'LineString',
      coordinates: [
        [...offsetMetres(SW, PARCEL_W / 2, -5)],
        [...offsetMetres(SW, PARCEL_W / 2, PARCEL_H + 5)],
      ],
    })

    expect(map.store.find('p')).toBeUndefined()
    expect(map.store.collection('parcels').size).toBe(2)
    expect(parts).toHaveLength(2)

    const total = map.store
      .collection('parcels')
      .all()
      .reduce((sum, feature) => sum + map.crs.area(feature.geometry), 0)
    // Within a square millimetre of the original: JSTS nodes the cut exactly, and the
    // sum of the halves is the number that has to agree with the deed.
    expect(total).toBeCloseTo(area, 3)

    // The properties ride along, and each half is a new feature with its own id.
    for (const part of map.store.collection('parcels').all()) {
      expect(part.properties['ada']).toBe('1234')
      expect(part.id).not.toBe('p')
    }

    await map.destroy()
  })

  it('refuses a line that does not fully cross, and changes nothing', async () => {
    const map = await mapWithParcel()
    const before = map.store.snapshot()

    await expect(
      map.plugin('edit').split('p', {
        type: 'LineString',
        coordinates: [
          [...offsetMetres(SW, PARCEL_W / 2, -5)],
          [...offsetMetres(SW, PARCEL_W / 2, PARCEL_H / 2)],
        ],
      }),
    ).rejects.toThrow(/does not cut this feature in two/)

    expect(map.store.snapshot()).toEqual(before)
    await map.destroy()
  })
})

describe('editPlugin — merge', () => {
  it('unions two contiguous parcels into one', async () => {
    const map = await createTestMap({
      plugins: [editPlugin()],
      features: { parcels: sharedEdgeParcels() },
    })
    const total = map.store
      .collection('parcels')
      .all()
      .reduce((sum, feature) => sum + map.crs.area(feature.geometry), 0)

    let merged: FlexiFeature | undefined
    map.events.on('edit:merge', (event) => {
      merged = event.payload.feature
    })

    await map.plugin('edit').merge(['parcel-left', 'parcel-right'])

    expect(map.store.collection('parcels').size).toBe(1)
    expect(merged).toBeDefined()
    expect(map.crs.area(merged!.geometry)).toBeCloseTo(total, 3)
    await map.destroy()
  })

  it('refuses to merge parcels that do not share an edge', async () => {
    const far = parcelFixture('far', { origin: offsetMetres(ANKARA, 500, 0) })
    const map = await createTestMap({
      plugins: [editPlugin()],
      features: { parcels: [parcelFixture('p'), far] },
    })
    const before = map.store.snapshot()

    await expect(map.plugin('edit').merge(['p', 'far'])).rejects.toThrow(/do not share an edge/)
    expect(map.store.snapshot()).toEqual(before)
    await map.destroy()
  })
})

describe('editPlugin — session events', () => {
  it('emits edit:start and edit:complete, and honours a veto', async () => {
    const map = await mapWithParcel()
    const seen: string[] = []
    map.events.on('edit:start', (event) => seen.push(`start:${event.payload.id}`))
    map.events.on('edit:complete', (event) => seen.push(`complete:${event.payload.id}`))

    map.plugin('edit').edit('p')
    expect(map.plugin('edit').editing).toBe('p')

    const veto = map.events.onBefore('before:edit:complete', (event) => {
      event.preventDefault('the parcel is still invalid')
    })
    map.plugin('edit').stop()
    // Vetoed: the user is still editing, and no completion was announced.
    expect(map.plugin('edit').editing).toBe('p')
    expect(seen).toEqual(['start:p'])

    veto.dispose()
    map.plugin('edit').stop()
    expect(map.plugin('edit').editing).toBeNull()
    expect(seen).toEqual(['start:p', 'complete:p'])

    await map.destroy()
  })

  it('ends the session when the feature it was editing is split away', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')

    await map.plugin('edit').split('p', {
      type: 'LineString',
      coordinates: [
        [...offsetMetres(SW, PARCEL_W / 2, -5)],
        [...offsetMetres(SW, PARCEL_W / 2, PARCEL_H + 5)],
      ],
    })

    expect(map.plugin('edit').editing).toBeNull()
    expect(map.store.collection('edit:vertices').size).toBe(0)
    await map.destroy()
  })
})

/** The midpoint handle the plugin itself drew between two corners. */
function midpointBetween(map: TestMap, a: LngLat, b: LngLat): LngLat {
  const wanted: LngLat = map.crs.working.inverse([
    (map.crs.working.forward(a)[0] + map.crs.working.forward(b)[0]) / 2,
    (map.crs.working.forward(a)[1] + map.crs.working.forward(b)[1]) / 2,
  ])
  const handle = [...map.store.collection('edit:midpoints')]
    .map((feature) => {
      const point = feature.geometry as { coordinates: number[] }
      return [point.coordinates[0]!, point.coordinates[1]!] as LngLat
    })
    .sort((x, y) => distanceMetres(x, wanted) - distanceMetres(y, wanted))[0]

  if (handle === undefined) throw new Error('no midpoint handles')
  return handle
}
