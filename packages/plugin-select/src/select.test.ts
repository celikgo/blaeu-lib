import { beforeEach, describe, expect, it } from 'vitest'
import { RemoveFeaturesCommand, UpdateFeaturesCommand } from '@fleximap/core'
import type { FeatureInput, FeatureId } from '@fleximap/core'
import { ANKARA, createTestMap, offsetMetres, parcelFixture } from '@fleximap/core/testing'
import type { TestMap } from '@fleximap/core/testing'
import { selectPlugin } from './index.js'
import type { SelectOptions } from './index.js'
import { HIGHLIGHT_LAYER } from './overlay.js'
import { BOX_TOOL, LASSO_TOOL, SINGLE_TOOL } from './tools.js'

/*
 * Three parcels in a row, 50 m × 40 m each, laid west→east from Kızılay. Distinct
 * and non-touching, so "the pointer is inside parcel B" is unambiguous — a fixture
 * whose parcels shared a corner would make a hit-test failure look like a selection
 * bug when it was really a fixture bug.
 */
const GAP_M = 10
const PITCH_M = 60 // 50 m wide + a 10 m gap

function parcels(): readonly FeatureInput[] {
  return ['a', 'b', 'c'].map((id, i) =>
    parcelFixture(id, { origin: offsetMetres(ANKARA, i * PITCH_M, 0) }),
  )
}

/** The centre of parcel `i`, which is where a click lands inside it. */
function centreOf(i: number): [number, number] {
  const [lng, lat] = offsetMetres(ANKARA, i * PITCH_M + 25, 20)
  return [lng, lat]
}

/** A point in the gap between parcels — empty map, guaranteed. */
function emptyPoint(): [number, number] {
  const [lng, lat] = offsetMetres(ANKARA, PITCH_M - GAP_M / 2, 20)
  return [lng, lat]
}

/**
 * The harness has no `layers` option, and the `FakeRenderer` only hit-tests sources
 * that a *visible layer* points at. Once this plugin adds its own two layers, the
 * renderer's "no layers at all → query everything" fallback no longer applies — so a
 * test that wants to click a parcel has to declare the parcel layer, exactly as a
 * real product does.
 */
async function createMap(
  options: SelectOptions = {},
  features: readonly FeatureInput[] = parcels(),
): Promise<TestMap> {
  const map = await createTestMap({
    plugins: [selectPlugin(options)],
    features: { parcels: features },
    camera: { center: ANKARA, zoom: 16 },
  })
  map.layers.add({ id: 'parcels', type: 'vector', source: 'parcels' })
  return map
}

describe('selectPlugin', () => {
  let map: TestMap

  beforeEach(async () => {
    map = await createMap()
  })

  /* =================================================================== */
  /* The three tests every plugin owes                                   */
  /* =================================================================== */

  describe('degradation', () => {
    it('selects on a bare kernel — no history, no snap, no ui plugin installed', async () => {
      const bare = await createMap()
      expect(bare.plugins.list().map((p) => p.id)).toEqual(['select'])

      bare.tools.activate(SINGLE_TOOL)
      bare.test.click(centreOf(1))

      expect([...bare.plugin('select').selected]).toEqual(['b'])
    })

    it('lassos with no history plugin to record it', async () => {
      const bare = await createMap()
      bare.tools.activate(LASSO_TOOL)
      lassoAround(bare, 0)
      expect([...bare.plugin('select').selected]).toEqual(['a'])
    })
  })

  describe('teardown', () => {
    it('leaks nothing on removal', async () => {
      const clean = await createTestMap()
      const before = clean.debug.snapshot()

      await clean.use(selectPlugin())
      clean.layers.add({ id: 'parcels', type: 'vector', source: 'parcels' })
      clean.test.seed('parcels', parcels())
      clean.tools.activate(SINGLE_TOOL)
      clean.test.click(centreOf(0))

      const subscription = clean.plugin('select').onChange(() => {})
      subscription.dispose()

      clean.layers.remove('parcels')
      await clean.remove('select')
      clean.store.removeCollection('parcels')

      expect(clean.debug.snapshot()).toEqual(before)
      expect(clean.tools.list()).toEqual([])
    })

    it('releases its renderer sources and layers', async () => {
      await map.remove('select')
      expect(map.test.renderer.layers.has(HIGHLIGHT_LAYER)).toBe(false)
      expect(map.test.renderer.sources.has('select:highlight')).toBe(false)
    })
  })

  describe('undo', () => {
    /*
     * The clearest case of the transient/committed split in the library. Selecting is
     * not an edit: it must leave the document byte-for-byte identical, and it must put
     * nothing on the undo stack — a Ctrl-Z that first un-selects three parcels before
     * deleting them is a Ctrl-Z every user reads as broken.
     */
    it('never touches the store and never dispatches a command', () => {
      const before = map.store.snapshot()
      const commands: string[] = []
      const sub = map.commands.onDidExecute((command) => commands.push(command.type))

      const select = map.plugin('select')
      map.tools.activate(BOX_TOOL)
      map.test.drag(offsetMetres(ANKARA, -10, -10), offsetMetres(ANKARA, 120, 50))
      select.select('c', 'add')
      select.select('a', 'toggle')
      select.clear()
      select.selectByFilter((f) => f.id === 'b')

      sub.dispose()
      expect(commands).toEqual([])
      expect(map.store.snapshot()).toEqual(before)
    })

    /*
     * The command bus holds no undo stack — history is a plugin, and this test must not
     * silently acquire a dependency on it to prove a property of the *command*. So the
     * round-trip is driven through the `Command` contract itself, which is what the
     * history plugin would drive too.
     */
    it('round-trips a command committed over the selection, to deep equality', async () => {
      const before = map.store.snapshot()

      const select = map.plugin('select')
      select.select(['a', 'b'])

      const command = new RemoveFeaturesCommand([...select.selected])
      expect((await map.commands.commit(command)).ok).toBe(true)
      expect(map.store.snapshot()).not.toEqual(before)
      expect([...select.selected]).toEqual([])

      command.undo({ store: map.store, events: map.events })
      expect(map.store.snapshot()).toEqual(before)
    })
  })

  /* =================================================================== */
  /* Selection semantics                                                 */
  /* =================================================================== */

  describe('modes', () => {
    it('replaces by default', () => {
      const select = map.plugin('select')
      select.select(['a', 'b'])
      select.select('c')
      expect([...select.selected]).toEqual(['c'])
    })

    it('adds, toggles and subtracts', () => {
      const select = map.plugin('select')
      select.select('a')
      select.select(['b', 'c'], 'add')
      expect([...select.selected].sort()).toEqual(['a', 'b', 'c'])

      select.select(['a', 'b'], 'toggle')
      expect([...select.selected]).toEqual(['c'])

      select.select(['b'], 'toggle')
      select.select(['c'], 'subtract')
      expect([...select.selected]).toEqual(['b'])
    })

    it('drops ids the store has never heard of', () => {
      const select = map.plugin('select')
      select.select(['a', 'ghost'])
      expect([...select.selected]).toEqual(['a'])
    })

    it('selects by filter', () => {
      const select = map.plugin('select')
      select.selectByFilter((f) => f.id !== 'b')
      expect([...select.selected].sort()).toEqual(['a', 'c'])
    })
  })

  describe('selectability', () => {
    it('will not select a locked feature by default', async () => {
      const locked = await createMap({}, [
        parcelFixture('a'),
        {
          ...parcelFixture('b', { origin: offsetMetres(ANKARA, PITCH_M, 0) }),
          meta: { locked: true },
        },
      ])
      const select = locked.plugin('select')

      select.select(['a', 'b'])
      expect([...select.selected]).toEqual(['a'])

      locked.tools.activate(SINGLE_TOOL)
      locked.test.click(centreOf(1))
      expect([...select.selected]).toEqual([])
    })

    it('selects a locked feature when selectLocked is on', async () => {
      const locked = await createMap({ selectLocked: true }, [
        { ...parcelFixture('a'), meta: { locked: true } },
      ])
      locked.plugin('select').select('a')
      expect([...locked.plugin('select').selected]).toEqual(['a'])
    })

    it('never selects a hidden feature, even with selectLocked on', async () => {
      const hidden = await createMap({ selectLocked: true }, [
        { ...parcelFixture('a'), meta: { hidden: true } },
      ])
      hidden.plugin('select').select('a')
      expect([...hidden.plugin('select').selected]).toEqual([])
    })

    it('honours the collections restriction', async () => {
      const scoped = await createTestMap({
        plugins: [selectPlugin({ collections: ['parcels'] })],
        features: { parcels: [parcelFixture('a')], buildings: [parcelFixture('shed')] },
        camera: { center: ANKARA, zoom: 16 },
      })
      const select = scoped.plugin('select')

      select.select(['a', 'shed'])
      expect([...select.selected]).toEqual(['a'])
    })

    it('still lets a feature locked after selection be subtracted', async () => {
      const select = map.plugin('select')
      select.select('a')

      const a = map.store.find('a')!
      await map.commands.commit(
        new UpdateFeaturesCommand([{ ...a, meta: { ...a.meta, locked: true } }]),
      )

      select.select('a', 'subtract')
      expect([...select.selected]).toEqual([])
    })
  })

  /* =================================================================== */
  /* Events                                                              */
  /* =================================================================== */

  describe('select:changed', () => {
    it('carries the deltas, not just the set', () => {
      const events: { selected: FeatureId[]; added: FeatureId[]; removed: FeatureId[] }[] = []
      const sub = map.events.on('select:changed', (event) => {
        events.push({
          selected: [...event.payload.selected],
          added: [...event.payload.added],
          removed: [...event.payload.removed],
        })
      })

      const select = map.plugin('select')
      select.select(['a', 'b'])
      select.select('c')
      sub.dispose()

      expect(events).toEqual([
        { selected: ['a', 'b'], added: ['a', 'b'], removed: [] },
        { selected: ['c'], added: ['c'], removed: ['a', 'b'] },
      ])
    })

    it('does not fire when nothing changed', () => {
      let fired = 0
      const sub = map.events.on('select:changed', () => fired++)
      const select = map.plugin('select')

      select.select('a')
      select.select('a')
      select.clear()
      select.clear()

      sub.dispose()
      expect(fired).toBe(2)
    })

    it('notifies onChange handlers and stops after dispose', () => {
      const seen: number[] = []
      const sub = map.plugin('select').onChange((ids) => seen.push(ids.size))

      map.plugin('select').select(['a', 'b'])
      sub.dispose()
      map.plugin('select').select('c')

      expect(seen).toEqual([2])
    })

    it('prunes features that are removed from the store', async () => {
      const select = map.plugin('select')
      select.select(['a', 'b'])

      await map.commands.commit(new RemoveFeaturesCommand(['a']))

      expect([...select.selected]).toEqual(['b'])
      expect(select.features.map((f) => f.id)).toEqual(['b'])
    })
  })

  /* =================================================================== */
  /* Highlight                                                           */
  /* =================================================================== */

  describe('highlight', () => {
    it('pushes the selected features into a dedicated renderer source', () => {
      map.plugin('select').select(['a', 'c'])
      const source = map.test.renderer.sources.get('select:highlight') ?? []
      expect(source.map((f) => f.id).sort()).toEqual(['a', 'c'])
    })

    it('is a renderer source, not a store collection — the document stays clean', () => {
      map.plugin('select').select('a')
      expect(map.store.collections()).not.toContain('select:highlight')
    })

    it('paints with the theme selection token', () => {
      const layer = map.test.renderer.layers.get(HIGHLIGHT_LAYER)
      expect(layer?.style.fill?.color).toBe(map.theme.token('color').selection)

      map.theme.set({ tokens: { color: { selection: '#ff0000' } } })
      expect(map.test.renderer.layers.get(HIGHLIGHT_LAYER)?.style.fill?.color).toBe('#ff0000')
    })
  })

  /* =================================================================== */
  /* Tools                                                               */
  /* =================================================================== */

  describe('select:single', () => {
    it('selects what is under the pointer and clears on a miss', () => {
      map.tools.activate(SINGLE_TOOL)
      const select = map.plugin('select')

      map.test.click(centreOf(1))
      expect([...select.selected]).toEqual(['b'])

      map.test.click(emptyPoint())
      expect([...select.selected]).toEqual([])
    })

    it('multi-selects with the multi key and toggles a repeat click', () => {
      map.tools.activate(SINGLE_TOOL)
      const select = map.plugin('select')

      map.test.click(centreOf(0))
      map.test.click(centreOf(1), { shift: true })
      expect([...select.selected].sort()).toEqual(['a', 'b'])

      map.test.click(centreOf(1), { shift: true })
      expect([...select.selected]).toEqual(['a'])
    })

    it('keeps the set when a multi-click misses', () => {
      map.tools.activate(SINGLE_TOOL)
      const select = map.plugin('select')

      map.test.click(centreOf(0))
      map.test.click(emptyPoint(), { shift: true })
      expect([...select.selected]).toEqual(['a'])
    })

    it('respects a custom multiKey — shift is then just a click', async () => {
      const ctrlMap = await createMap({ multiKey: 'ctrl' })
      ctrlMap.tools.activate(SINGLE_TOOL)
      const select = ctrlMap.plugin('select')

      ctrlMap.test.click(centreOf(0))
      ctrlMap.test.click(centreOf(1), { shift: true })
      expect([...select.selected]).toEqual(['b'])

      ctrlMap.test.click(centreOf(0), { ctrl: true })
      expect([...select.selected].sort()).toEqual(['a', 'b'])
    })

    it('subtracts with alt', () => {
      map.tools.activate(SINGLE_TOOL)
      const select = map.plugin('select')
      select.select(['a', 'b'])

      map.test.click(centreOf(0), { alt: true })
      expect([...select.selected]).toEqual(['b'])
    })
  })

  describe('select:box', () => {
    it('selects everything the drag box touches', () => {
      map.tools.activate(BOX_TOOL)
      // A box from south-west of parcel a to north-east of parcel b, stopping short of c.
      map.test.drag(offsetMetres(ANKARA, -10, -10), offsetMetres(ANKARA, 105, 50))
      expect([...map.plugin('select').selected].sort()).toEqual(['a', 'b'])
    })

    it('adds to the selection with the multi key held at press', () => {
      const select = map.plugin('select')
      select.select('c')

      map.tools.activate(BOX_TOOL)
      map.test.renderer.emitPointer({
        kind: 'pointerdown',
        lngLat: offsetMetres(ANKARA, -10, -10),
        modifiers: { shift: true },
      })
      map.test.renderer.emitPointer({ kind: 'pointermove', lngLat: offsetMetres(ANKARA, 30, 30) })
      map.test.renderer.emitPointer({ kind: 'pointerup', lngLat: offsetMetres(ANKARA, 60, 50) })

      expect([...select.selected].sort()).toEqual(['a', 'c'])
    })

    it('treats a press that never moved as a click', () => {
      map.tools.activate(BOX_TOOL)
      const select = map.plugin('select')

      map.test.pointerDown(centreOf(1))
      map.test.pointerUp(centreOf(1))
      expect([...select.selected]).toEqual(['b'])
    })

    it('draws a marquee while dragging and clears it on release', () => {
      map.tools.activate(BOX_TOOL)
      map.test.pointerDown(offsetMetres(ANKARA, -10, -10))
      map.test.pointerMove(offsetMetres(ANKARA, 60, 40))
      expect(map.test.renderer.sources.get('select:preview')?.length).toBe(1)

      map.test.pointerUp(offsetMetres(ANKARA, 60, 40))
      expect(map.test.renderer.sources.get('select:preview')?.length).toBe(0)
    })

    it('cancels on Escape without changing the selection', () => {
      map.tools.activate(BOX_TOOL)
      const select = map.plugin('select')
      select.select('c')

      map.test.pointerDown(offsetMetres(ANKARA, -10, -10))
      map.test.pointerMove(offsetMetres(ANKARA, 60, 40))
      map.test.key('Escape')
      map.test.pointerUp(offsetMetres(ANKARA, 60, 40))

      expect([...select.selected]).toEqual(['c'])
      expect(map.test.renderer.sources.get('select:preview')?.length).toBe(0)
    })
  })

  describe('select:lasso', () => {
    it('selects features whose centroid falls inside the ring', () => {
      map.tools.activate(LASSO_TOOL)
      lassoAround(map, 0)
      expect([...map.plugin('select').selected]).toEqual(['a'])
    })

    it('leaves out a parcel the ring only clips', () => {
      map.tools.activate(LASSO_TOOL)

      // A ring around parcel a that overruns into parcel b's western strip. b's
      // *centroid* is well outside it, so b must not come along.
      traceRing(map, [
        offsetMetres(ANKARA, -5, -5),
        offsetMetres(ANKARA, 70, -5),
        offsetMetres(ANKARA, 70, 45),
        offsetMetres(ANKARA, -5, 45),
      ])

      expect([...map.plugin('select').selected]).toEqual(['a'])
    })

    it('selects two parcels at once and shows the trace while drawing', () => {
      map.tools.activate(LASSO_TOOL)

      map.test.pointerDown(offsetMetres(ANKARA, -5, -5))
      map.test.pointerMove(offsetMetres(ANKARA, 130, -5))
      expect(map.test.renderer.sources.get('select:preview')?.length).toBe(1)
      map.test.pointerMove(offsetMetres(ANKARA, 130, 45))
      map.test.pointerMove(offsetMetres(ANKARA, -5, 45))
      map.test.pointerUp(offsetMetres(ANKARA, -5, 45))

      expect([...map.plugin('select').selected].sort()).toEqual(['a', 'b'])
      expect(map.test.renderer.sources.get('select:preview')?.length).toBe(0)
    })

    it('treats a tap as a click rather than as an empty ring that clears', () => {
      const select = map.plugin('select')
      select.select('c')

      map.tools.activate(LASSO_TOOL)
      map.test.pointerDown(centreOf(0))
      map.test.pointerUp(centreOf(0))

      expect([...select.selected]).toEqual(['a'])
    })

    it('cancels on Escape', () => {
      map.tools.activate(LASSO_TOOL)
      const select = map.plugin('select')
      select.select('c')

      map.test.pointerDown(offsetMetres(ANKARA, -5, -5))
      map.test.pointerMove(offsetMetres(ANKARA, 60, -5))
      map.test.pointerMove(offsetMetres(ANKARA, 60, 45))
      map.test.key('Escape')
      map.test.pointerUp(offsetMetres(ANKARA, 60, 45))

      expect([...select.selected]).toEqual(['c'])
    })
  })

  /* =================================================================== */
  /* Lifecycle                                                           */
  /* =================================================================== */

  describe('enable / disable', () => {
    it('keeps the selection across a disable, and hides the highlight', () => {
      const select = map.plugin('select')
      select.select(['a', 'b'])

      map.tools.activate(SINGLE_TOOL)
      map.plugins.disable('select')

      expect([...select.selected].sort()).toEqual(['a', 'b'])
      expect(map.tools.active).toBeNull()
      expect(map.test.renderer.layers.get(HIGHLIGHT_LAYER)?.visible).toBe(false)

      map.plugins.enable('select')
      expect(map.test.renderer.layers.get(HIGHLIGHT_LAYER)?.visible).toBe(true)
    })
  })
})

/* ======================================================================= */
/* Gesture helpers                                                         */
/* ======================================================================= */

/** A freehand ring, traced vertex by vertex the way a hand would. */
function traceRing(map: TestMap, ring: readonly (readonly [number, number])[]): void {
  const [first, ...rest] = ring
  if (first === undefined) return
  map.test.pointerDown(first)
  for (const point of rest) map.test.pointerMove(point)
  const lastPoint = rest[rest.length - 1] ?? first
  map.test.pointerUp(lastPoint)
}

/** A lasso comfortably around parcel `i` and nothing else. */
function lassoAround(map: TestMap, i: number): void {
  const x = i * PITCH_M
  traceRing(map, [
    offsetMetres(ANKARA, x - 5, -5),
    offsetMetres(ANKARA, x + 55, -5),
    offsetMetres(ANKARA, x + 55, 45),
    offsetMetres(ANKARA, x - 5, 45),
  ])
}
