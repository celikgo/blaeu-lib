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
} from '@blaeu/core/testing'
import { ringSignedArea2 } from '@blaeu/core'
import type { Command, FeatureId, BlaeuFeature, LngLat, Polygon } from '@blaeu/core'

import { editPlugin } from './index.js'
import { CommitEditCommand, MoveVerticesCommand } from './commands.js'

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

/** A LngLat as a bare coordinate pair, for building a geometry literal. */
const xy = (p: LngLat): [number, number] => [p[0], p[1]]

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
    // The drag previews synchronously; the one durable, validated write lands on
    // release, through the async commit pipeline.
    await map.test.flush()
    off.dispose()

    expect(corners(map, 'p')).toHaveLength(5)

    // Insert and drag are one gesture — one durable command, one Ctrl-Z.
    expect(captured.filter((c) => c instanceof CommitEditCommand)).toHaveLength(1)

    for (let i = captured.length - 1; i >= 0; i--) map.commands._apply(captured[i]!, 'undo')
    expect(corners(map, 'p')).toHaveLength(4)
    expect(map.store.collection('parcels').all()).toEqual(
      (before.collections['parcels'] ?? []).slice(),
    )

    await map.destroy()
  })

  // The one-shot commit path (#applyOnce) is separate from the drag path, and it must
  // hold the same deep-equality contract — version and updatedAt included, not just
  // geometry — or a "dirty since save" / collaboration consumer keyed on version is lied to.
  it('round-trips a one-shot vertex delete through the public commit path', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')
    // The parcel itself — not the edit handles, which are transient UI that churns.
    const before = map.store.collection('parcels').all()

    const captured: Command[] = []
    const off = map.commands.onDidExecute((command) => captured.push(command))

    // Alt-click a corner: a discrete delete, previewed then committed once.
    map.test.pointerDown(cornerNear(map, 'p', NE), { alt: true })
    await map.test.flush()
    off.dispose()

    expect(corners(map, 'p')).toHaveLength(3)
    expect(captured.filter((c) => c instanceof CommitEditCommand)).toHaveLength(1)

    for (let i = captured.length - 1; i >= 0; i--) map.commands._apply(captured[i]!, 'undo')
    // Deep equality, not just corner count — the pre-edit version and updatedAt too.
    expect(map.store.collection('parcels').all()).toEqual(before)

    await map.destroy()
  })

  it('round-trips a programmatic move through the public commit path', async () => {
    const map = await mapWithParcel()
    const before = map.store.collection('parcels').all()

    const captured: Command[] = []
    const off = map.commands.onDidExecute((command) => captured.push(command))

    // The public API, no gesture — the other #applyOnce entry.
    map.plugin('edit').move(['p'], [10, 5])
    await map.test.flush()
    off.dispose()

    expect(map.store.collection('parcels').all()).not.toEqual(before)
    const commits = captured.filter((c) => c instanceof CommitEditCommand)
    expect(commits).toHaveLength(1)

    map.commands._apply(commits[0]!, 'undo')
    expect(map.store.collection('parcels').all()).toEqual(before)

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
    await map.test.flush()
    off.dispose()

    // Both parcels followed the corner. If one of them had not, two adjacent parcels
    // would now overlap by 3 m² — which is a boundary dispute, not a redraw.
    expectWithinMetres(cornerNear(map, 'parcel-left', target), target, 0.002)
    expectWithinMetres(cornerNear(map, 'parcel-right', target), target, 0.002)

    // One gesture, one durable command — and undoing that single command must put
    // *both* parcels back, or the shared corner is not really shared.
    const commits = commands.filter((command) => command instanceof CommitEditCommand)
    expect(commits).toHaveLength(1)
    map.commands._apply(commits[0]!, 'undo')
    expectWithinMetres(cornerNear(map, 'parcel-left', shared), shared, 0.001)
    expectWithinMetres(cornerNear(map, 'parcel-right', shared), shared, 0.001)

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

describe('editPlugin — vertex drag across the polygon (ring re-winding)', () => {
  // The audit critical: a drag addresses corners by positional index, but the store
  // used to rewind (reverse) a ring the instant an edit flipped its winding. Dragging
  // a triangle's apex across its base flips the winding, so from that frame on the
  // drag rewrote a *base* corner instead of the apex — silently, with no error. The
  // fix (ADR 0011) keeps the ring order stable across the transient previews, and
  // rewinds once, on the durable commit.
  it('keeps addressing the dragged corner after the winding flips, and leaves the rest put', async () => {
    const BL = ANKARA // base, left
    const BR = offsetMetres(ANKARA, 40, 0) // base, right
    const APEX = offsetMetres(ANKARA, 20, 30) // above the base — ingest winds this CCW
    const map = await createTestMap({
      plugins: [editPlugin()],
      features: {
        parcels: [
          {
            id: 'tri',
            geometry: {
              type: 'Polygon',
              coordinates: [[xy(BL), xy(BR), xy(APEX), xy(BL)]],
            } as Polygon,
          },
        ],
      },
    })

    map.plugin('edit').edit('tri')

    // Drag the apex straight down, across the base and out the far side. Several of the
    // interpolated frames land below the base, where the triangle is inverted (its
    // signed area has flipped) — the exact state that used to reverse the ring.
    const apexStart = cornerNear(map, 'tri', APEX)
    const target = offsetMetres(ANKARA, 20, -30)
    map.test.drag(apexStart, target, { steps: 16 })
    await map.test.flush()

    // Still a triangle: no corner lost or duplicated by a mid-drag reversal.
    expect(corners(map, 'tri')).toHaveLength(3)

    // The two base corners the user never touched are exactly where they started.
    expectWithinMetres(cornerNear(map, 'tri', BL), BL, 0.01)
    expectWithinMetres(cornerNear(map, 'tri', BR), BR, 0.01)

    // The dragged corner — and only it — followed the cursor all the way to the target.
    expectWithinMetres(cornerNear(map, 'tri', target), target, 0.01)

    // The committed parcel is wound RFC 7946 (a positive exterior area is CCW), even
    // though it was inverted mid-drag: the rewind lands once, on commit, deed-safe.
    const stored = ring(map, 'tri').map((p) => [p[0], p[1]] as [number, number])
    expect(ringSignedArea2(stored)).toBeGreaterThan(0)

    await map.destroy()
  })

  // Review follow-up: the commit's rewind reorders the ring, which used to invalidate any
  // positional ref that outlived it. The Delete key held such a ref (`active`).
  it('Delete after a winding-flipping drag removes the dragged corner, not a stale one', async () => {
    // A quad wound CCW on ingest; a delete needs >=4 corners (a triangle's is refused).
    const A = ANKARA
    const B = offsetMetres(ANKARA, 40, 0)
    const C = offsetMetres(ANKARA, 40, 40)
    const D = offsetMetres(ANKARA, 0, 40)
    const map = await createTestMap({
      plugins: [editPlugin()],
      features: {
        parcels: [
          {
            id: 'q',
            geometry: {
              type: 'Polygon',
              coordinates: [[xy(A), xy(B), xy(C), xy(D), xy(A)]],
            } as Polygon,
          },
        ],
      },
    })

    map.plugin('edit').edit('q')

    // Drag corner D out past the far side so the quad's net winding flips (it stays a
    // simple polygon). On commit the ring is rewound, reordering every corner's index.
    const target = offsetMetres(ANKARA, 60, -20)
    map.test.drag(cornerNear(map, 'q', D), target, { steps: 16 })
    await map.test.flush()
    expect(corners(map, 'q')).toHaveLength(4)
    expectWithinMetres(cornerNear(map, 'q', target), target, 0.01)

    // Delete acts on the corner we were working on — the one just dragged to `target`.
    map.test.key('Delete')
    await map.test.flush()

    expect(corners(map, 'q')).toHaveLength(3)
    // The three untouched corners survive; the dragged one is gone.
    expectWithinMetres(cornerNear(map, 'q', A), A, 0.01)
    expectWithinMetres(cornerNear(map, 'q', B), B, 0.01)
    expectWithinMetres(cornerNear(map, 'q', C), C, 0.01)
    expect(distanceMetres(cornerNear(map, 'q', target), target)).toBeGreaterThan(1)

    await map.destroy()
  })

  // Review follow-up (medium): the durable commit runs asynchronously, so if it were the
  // first thing to rewind an inverted ring it could reorder the ring under a re-entrant
  // gesture's live refs. The controller converges the winding synchronously on release.
  it('converges the ring to committed winding synchronously on release, before the async commit', async () => {
    const BL = ANKARA
    const BR = offsetMetres(ANKARA, 40, 0)
    const APEX = offsetMetres(ANKARA, 20, 30)
    const map = await createTestMap({
      plugins: [editPlugin()],
      features: {
        parcels: [
          {
            id: 'tri',
            geometry: {
              type: 'Polygon',
              coordinates: [[xy(BL), xy(BR), xy(APEX), xy(BL)]],
            } as Polygon,
          },
        ],
      },
    })

    map.plugin('edit').edit('tri')
    map.test.drag(cornerNear(map, 'tri', APEX), offsetMetres(ANKARA, 20, -30), { steps: 16 })

    // NOTE: no flush(). The async commit has not run yet — but the store must already be
    // in RFC 7946 winding, so a re-entrant gesture starting now (and the late commit) both
    // see the final ring order. Without the synchronous converge this would be clockwise.
    const onRelease = ring(map, 'tri').map((p) => [p[0], p[1]] as [number, number])
    expect(ringSignedArea2(onRelease)).toBeGreaterThan(0)

    await map.test.flush()
    const afterCommit = ring(map, 'tri').map((p) => [p[0], p[1]] as [number, number])
    expect(ringSignedArea2(afterCommit)).toBeGreaterThan(0)

    await map.destroy()
  })
})

describe('editPlugin — a drag released off the canvas', () => {
  // The audit high: a pointerup that lands outside the canvas is never delivered, so onPointerUp
  // never fires and the gesture never ends — the geometry keeps chasing the cursor with the
  // button up. The next move the canvas *does* see (on re-entry) carries `buttons === 0`, and the
  // tools now treat that as the missed release.

  it('ends a vertex drag on the first move that arrives with the button already up', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')

    // Grab the NE corner; the gesture is now in flight and the kernel is latched onto the parcel.
    map.test.pointerDown(cornerNear(map, 'p', NE))
    map.test.pointerMove(offsetMetres(NE, 5, 5))
    expect(map.tools.dragging.length).toBeGreaterThan(0)

    // Released off-canvas: no pointerup reached us, and the next move has no button held.
    map.test.pointerMove(offsetMetres(NE, 10, 10), undefined, 0)
    expect(map.tools.dragging).toEqual([])

    // And it stays ended — a further move does not resume the drag.
    map.test.pointerMove(offsetMetres(NE, 20, 20))
    expect(map.tools.dragging).toEqual([])

    await map.destroy()
  })

  it('ends a transform gesture on the first move that arrives with the button already up', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')
    map.tools.activate('edit:transform')

    // Pointer-down inside the parcel starts a move gesture.
    const from = offsetMetres(ANKARA, PARCEL_W / 2, PARCEL_H / 2)
    map.test.pointerDown(from)
    map.test.pointerMove(offsetMetres(from, 5, 0))
    expect(map.tools.dragging.length).toBeGreaterThan(0)

    // Released off-canvas.
    map.test.pointerMove(offsetMetres(from, 10, 0), undefined, 0)
    expect(map.tools.dragging).toEqual([])

    await map.destroy()
  })

  it('clears the dragging latch when the tool is switched away mid-drag', async () => {
    const map = await mapWithParcel()
    map.plugin('edit').edit('p')

    map.test.pointerDown(cornerNear(map, 'p', NE))
    map.test.pointerMove(offsetMetres(NE, 5, 5))
    expect(map.tools.dragging.length).toBeGreaterThan(0)

    // Switch tools mid-drag: the vertex tool deactivates and must not leave the kernel latched
    // onto the parcel — the next tool would otherwise inherit a gesture it never began.
    map.tools.activate('edit:transform')
    expect(map.tools.dragging).toEqual([])

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

    const parts: BlaeuFeature[] = []
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

  it('refuses to split a self-intersecting parcel, and changes nothing', async () => {
    // An asymmetric bowtie: self-intersecting, but with non-zero area so it survives
    // ingest (normaliseRing rejects only zero-area/degenerate rings; self-intersection is
    // plugin-topology's job, and a bare edit map need not have it). Before the fix,
    // splitPolygon ran UnionOp/Polygonizer/RelateOp on it — an opaque JTS crash or a
    // silently wrong split — instead of a clear, coordinate-naming rejection.
    const A = SW
    const B = offsetMetres(SW, 40, 40)
    const C = offsetMetres(SW, 40, 0)
    const D = offsetMetres(SW, 0, 20)
    const map = await createTestMap({
      plugins: [editPlugin()],
      features: {
        parcels: [
          {
            id: 'bowtie',
            geometry: {
              type: 'Polygon',
              coordinates: [[xy(A), xy(B), xy(C), xy(D), xy(A)]],
            } as Polygon,
          },
        ],
      },
    })
    const before = map.store.snapshot()

    await expect(
      map.plugin('edit').split('bowtie', {
        type: 'LineString',
        coordinates: [[...offsetMetres(SW, 20, -5)], [...offsetMetres(SW, 20, 45)]],
      }),
    ).rejects.toThrow(/invalid/i)

    expect(map.store.snapshot()).toEqual(before)
    await map.destroy()
  })
})

describe('editPlugin — split/merge tools surface an async refusal', () => {
  it('a refused cut through the split tool emits map:error and keeps the line on screen', async () => {
    const map = await mapWithParcel()
    const errors: Array<{ source?: string }> = []
    map.events.on('map:error', (e) => errors.push(e.payload as { source?: string }))

    map.tools.activate('edit:split')
    // A cut that lies entirely inside the parcel never crosses its boundary, so the split is
    // refused. The first click, landing on the parcel, also adopts it as the target.
    map.test.click(offsetMetres(SW, 10, 10))
    map.test.click(offsetMetres(SW, 40, 30))
    map.test.dblClick(offsetMetres(SW, 40, 30))
    // split() is async (it runs the commit pipeline). The refusal must reach the tool's handler
    // as a map:error, not escape as an unhandled promise rejection past a dead sync try/catch.
    await map.test.flush()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.source).toBe('edit:split')
    // And the cut line is still on screen — the docstring's promise — because the reset now
    // runs only on success, not synchronously before the async cut is even attempted.
    expect(map.store.collection('edit:guides').all()).toHaveLength(1)
    await map.destroy()
  })

  it('a refused merge through the merge tool emits map:error, not an unhandled rejection', async () => {
    // Two parcels ~70 m apart: they share no edge, so the merge is refused for non-contiguity.
    const far = offsetMetres(SW, 120, 0)
    const rectAt = (origin: LngLat): Polygon => ({
      type: 'Polygon',
      coordinates: [
        [
          [...origin],
          [...offsetMetres(origin, 50, 0)],
          [...offsetMetres(origin, 50, 40)],
          [...offsetMetres(origin, 0, 40)],
          [...origin],
        ],
      ],
    })
    const map = await createTestMap({
      plugins: [editPlugin()],
      features: {
        parcels: [
          { id: 'a', geometry: rectAt(SW), properties: {} },
          { id: 'b', geometry: rectAt(far), properties: {} },
        ],
      },
    })
    const errors: Array<{ source?: string }> = []
    map.events.on('map:error', (e) => errors.push(e.payload as { source?: string }))

    map.tools.activate('edit:merge')
    map.test.click(offsetMetres(SW, 25, 20)) // inside parcel a
    map.test.click(offsetMetres(far, 25, 20)) // inside parcel b
    map.test.dblClick(offsetMetres(far, 25, 20))
    await map.test.flush()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.source).toBe('edit:merge')
    // Neither parcel was consumed — the refused merge changed nothing.
    expect(map.store.collection('parcels').size).toBe(2)
    await map.destroy()
  })

  it('debounces a repeated finish() on the split tool into a single cut', async () => {
    const map = await mapWithParcel()
    const errors: unknown[] = []
    map.events.on('map:error', () => errors.push(1))

    map.tools.activate('edit:split')
    map.test.click(offsetMetres(SW, 10, 10))
    map.test.click(offsetMetres(SW, 40, 30))
    // Two finishes back-to-back, before the async cut settles: the reset that used to make the
    // second a no-op now runs only once the first lands, so the in-flight guard is the only
    // thing stopping a concurrent second cut. Exactly one cut is attempted → exactly one error.
    map.test.dblClick(offsetMetres(SW, 40, 30))
    map.test.dblClick(offsetMetres(SW, 40, 30))
    await map.test.flush()

    expect(errors).toHaveLength(1)
    await map.destroy()
  })

  it('debounces a repeated finish() on the merge tool into a single union', async () => {
    const far = offsetMetres(SW, 120, 0)
    const rectAt = (origin: LngLat): Polygon => ({
      type: 'Polygon',
      coordinates: [
        [
          [...origin],
          [...offsetMetres(origin, 50, 0)],
          [...offsetMetres(origin, 50, 40)],
          [...offsetMetres(origin, 0, 40)],
          [...origin],
        ],
      ],
    })
    const map = await createTestMap({
      plugins: [editPlugin()],
      features: {
        parcels: [
          { id: 'a', geometry: rectAt(SW), properties: {} },
          { id: 'b', geometry: rectAt(far), properties: {} },
        ],
      },
    })
    const errors: unknown[] = []
    map.events.on('map:error', () => errors.push(1))

    map.tools.activate('edit:merge')
    map.test.click(offsetMetres(SW, 25, 20))
    map.test.click(offsetMetres(far, 25, 20))
    map.test.dblClick(offsetMetres(far, 25, 20))
    map.test.dblClick(offsetMetres(far, 25, 20))
    await map.test.flush()

    expect(errors).toHaveLength(1)
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

    let merged: BlaeuFeature | undefined
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
