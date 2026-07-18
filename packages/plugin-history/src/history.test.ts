import { describe, expect, it, vi } from 'vitest'
import {
  AddFeaturesCommand,
  RemoveFeaturesCommand,
  SetPropertiesCommand,
  UpdateFeaturesCommand,
  type Command,
  type CommandContext,
  type CommitCommand,
  type BlaeuFeature,
  type Polygon,
} from '@blaeu/core'
import { ANKARA, createTestMap, offsetMetres, parcelFixture } from '@blaeu/core/testing'
import type { TestMap } from '@blaeu/core/testing'
import { historyPlugin } from './index.js'
import { bindKeyboard, type KeyboardTarget } from './keyboard.js'

/* ========================================================================= */
/* Helpers                                                                   */
/* ========================================================================= */

async function mapWithHistory(options: Parameters<typeof historyPlugin>[0] = {}): Promise<TestMap> {
  return createTestMap({
    plugins: [historyPlugin({ keyboard: false, ...options })],
    features: { parcels: [parcelFixture('seed-1')] },
  })
}

/** A parcel nobody else has minted. Ids must be unique or the store rejects the add. */
function newParcel(n: number) {
  return parcelFixture(`p-${n}`, { origin: offsetMetres(ANKARA, n * 120, 0) })
}

/** Translate a polygon east/north. Enough to change the geometry, not enough to leave the CRS. */
function translated(feature: BlaeuFeature, east: number, north: number): BlaeuFeature {
  const polygon = feature.geometry as Polygon
  return {
    ...feature,
    geometry: {
      type: 'Polygon',
      coordinates: polygon.coordinates.map((ring) =>
        ring.map((position) => {
          const moved = offsetMetres([position[0] ?? 0, position[1] ?? 0], east, north)
          return [moved[0], moved[1]]
        }),
      ),
    },
  }
}

/**
 * Mulberry32. Seeded, so a failure is a bug report and not a ghost story: the
 * seed is printed in the assertion and re-running with it reproduces the exact
 * command sequence.
 */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ========================================================================= */
/* The three tests every plugin owes                                         */
/* ========================================================================= */

describe('the three tests every plugin owes', () => {
  it('works with no other plugin installed (it has no dependencies, optional or otherwise)', async () => {
    const map = await mapWithHistory()
    const history = map.plugin('history')

    await map.commands.commit(new AddFeaturesCommand('parcels', [newParcel(1)]))

    expect(history.canUndo).toBe(true)
    expect(history.undo()).toBe(true)
    expect(map.store.collection('parcels').size).toBe(1)
  })

  it('leaks nothing on removal', async () => {
    const bare = await createTestMap({ features: { parcels: [parcelFixture('seed-1')] } })
    const baseline = bare.debug.snapshot()

    const map = await mapWithHistory()
    await map.commands.commit(new AddFeaturesCommand('parcels', [newParcel(1)]))
    map.plugin('history').undo()

    await map.remove('history')

    expect(map.debug.snapshot()).toEqual(baseline)
  })

  it('round-trips a command to deep equality', async () => {
    const map = await mapWithHistory()
    const history = map.plugin('history')
    const before = map.store.snapshot()

    await map.commands.commit(new AddFeaturesCommand('parcels', [newParcel(1)]))
    expect(map.store.snapshot()).not.toEqual(before)

    expect(history.undo()).toBe(true)
    expect(map.store.snapshot()).toEqual(before)

    expect(history.redo()).toBe(true)
    expect(map.store.snapshot()).not.toEqual(before)
  })
})

/* ========================================================================= */
/* The property test                                                         */
/* ========================================================================= */

describe('property: undoing everything restores the store exactly', () => {
  // Fixed seeds, not Math.random: a suite that fails once in fifty runs and cannot
  // be made to fail again is worse than no suite at all.
  const seeds = [1, 7, 42, 1337, 20240614, 99991]

  for (const seed of seeds) {
    it(`seed ${seed}: 60 random add/move/delete/attribute commands undo back to deep equality`, async () => {
      const map = await createTestMap({
        plugins: [historyPlugin({ keyboard: false, limit: 1000 })],
        features: {
          parcels: [
            parcelFixture('seed-1'),
            parcelFixture('seed-2', { origin: offsetMetres(ANKARA, 200, 0) }),
          ],
        },
      })
      const history = map.plugin('history')
      const random = prng(seed)

      // Seeding is transient, so this is the state Ctrl+Z must be able to reach —
      // and must not be able to go past.
      const initial = map.store.snapshot()
      let minted = 0
      let dispatched = 0

      for (let step = 0; step < 60; step++) {
        const ids = map.store
          .collections()
          .flatMap((id) => map.store.collection(id).all())
          .map((feature) => feature.id)
        const pick = (): string => ids[Math.floor(random() * ids.length)] ?? ''

        // Weighted so the store neither empties out nor grows monotonically: an
        // empty store makes move/delete unreachable and the test stops testing them.
        const roll = ids.length === 0 ? 0 : random()
        // Every one of the four writes features, so every one goes through `commit()`.
        let command: CommitCommand<readonly BlaeuFeature[]>

        if (roll < 0.35) {
          command = new AddFeaturesCommand('parcels', [newParcel(++minted)])
        } else if (roll < 0.6) {
          const feature = map.store.find(pick())
          if (feature === undefined) continue
          command = new UpdateFeaturesCommand([
            translated(feature, (random() - 0.5) * 20, (random() - 0.5) * 20),
          ])
        } else if (roll < 0.8) {
          command = new RemoveFeaturesCommand([pick()])
        } else {
          command = new SetPropertiesCommand([pick()], { ada: `A${Math.floor(random() * 1000)}` })
        }

        const result = await map.commands.commit(command)
        expect(result.ok, `seed ${seed} step ${step}: commit was rejected`).toBe(true)
        dispatched++
      }

      expect(dispatched).toBeGreaterThan(0)
      expect(history.depth).toBeGreaterThan(0)
      expect(map.store.snapshot(), `seed ${seed}: 60 commands changed nothing`).not.toEqual(initial)

      // Coalescing means depth <= dispatched, so drain the stack rather than
      // counting Ctrl-Zs.
      let undone = 0
      while (history.canUndo) {
        expect(history.undo(), `seed ${seed}: undo #${undone + 1} failed`).toBe(true)
        undone++
        expect(undone).toBeLessThanOrEqual(dispatched + 1)
      }

      // The whole point. No tolerance, no "visually identical": the same bytes.
      expect(map.store.snapshot(), `seed ${seed}: undo did not restore the store`).toEqual(initial)

      // And redo must walk the whole way back to where we stopped.
      const end = { redone: 0 }
      while (history.canRedo) {
        expect(history.redo(), `seed ${seed}: redo #${end.redone + 1} failed`).toBe(true)
        end.redone++
      }
      expect(end.redone).toBe(undone)
      expect(map.store.snapshot()).not.toEqual(initial)
    })
  }
})

/* ========================================================================= */
/* Recording rules                                                           */
/* ========================================================================= */

describe('recording', () => {
  it('clears the redo stack when something new is done', async () => {
    const map = await mapWithHistory()
    const history = map.plugin('history')

    await map.commands.commit(new AddFeaturesCommand('parcels', [newParcel(1)]))
    history.undo()
    expect(history.canRedo).toBe(true)

    await map.commands.commit(new AddFeaturesCommand('parcels', [newParcel(2)]))
    expect(history.canRedo).toBe(false)
    expect(history.depth).toBe(1)
  })

  it('never records a transient command', async () => {
    const map = await mapWithHistory()
    const history = map.plugin('history')

    map.commands.dispatch(new PreviewCommand())

    expect(history.depth).toBe(0)
    expect(history.canUndo).toBe(false)
  })

  it('records a transaction as one entry, labelled by the transaction', async () => {
    const map = await mapWithHistory()
    const history = map.plugin('history')
    const before = map.store.snapshot()

    await map.commands.commitTransaction('Split parcel', async (tx) => {
      await tx.commit(new RemoveFeaturesCommand(['seed-1']))
      await tx.commit(new AddFeaturesCommand('parcels', [newParcel(1), newParcel(2)]))
    })

    expect(history.depth).toBe(1)
    expect(history.undoLabel).toBe('Split parcel')

    history.undo()
    expect(map.store.snapshot()).toEqual(before)
  })

  it('drops the oldest entry when the limit is reached', async () => {
    const map = await mapWithHistory({ limit: 3 })
    const history = map.plugin('history')

    for (let i = 1; i <= 5; i++) {
      await map.commands.commit(new AddFeaturesCommand('parcels', [newParcel(i)]))
    }

    expect(history.depth).toBe(3)

    // The two oldest adds are gone from history, so their features survive the undos.
    while (history.canUndo) history.undo()
    expect(map.store.collection('parcels').size).toBe(3) // seed-1 + the two dropped adds
  })

  it('coalesces two edits of the same attribute into one undo step', async () => {
    const map = await mapWithHistory()
    const history = map.plugin('history')
    const before = map.store.snapshot()

    await map.commands.commit(new SetPropertiesCommand(['seed-1'], { ada: 'Kad' }))
    await map.commands.commit(new SetPropertiesCommand(['seed-1'], { ada: 'Kadıköy' }))

    expect(history.depth).toBe(1)
    expect(map.store.find('seed-1')?.properties['ada']).toBe('Kadıköy')

    // One Ctrl-Z, all the way back to the value before the first keystroke.
    history.undo()
    expect(map.store.snapshot()).toEqual(before)
  })

  it('does not coalesce across the window', async () => {
    const map = await mapWithHistory({ coalesceWindowMs: 0 })
    const history = map.plugin('history')

    await map.commands.commit(new SetPropertiesCommand(['seed-1'], { ada: 'Kad' }))
    await map.commands.commit(new SetPropertiesCommand(['seed-1'], { ada: 'Kadıköy' }))

    expect(history.depth).toBe(2)
  })

  it('does not record commands dispatched by an undo (the re-entrancy guard)', async () => {
    const map = await mapWithHistory()
    const history = map.plugin('history')

    // A bookkeeping plugin that keeps derived state in step. Its command rides in on
    // the undo of somebody else's — and must not land on the stack.
    let echoing = false
    map.events.on('feature:removed', () => {
      if (echoing) return
      echoing = true
      // A sync event handler cannot await, so the bookkeeping write is fire-and-forget —
      // exactly as the draw/measure tools now issue theirs.
      void map.commands.commit(new AddFeaturesCommand('audit', [newParcel(900)]))
      echoing = false
    })

    await map.commands.commit(new AddFeaturesCommand('parcels', [newParcel(1)]))
    expect(history.depth).toBe(1)

    history.undo() // removes the parcel → fires feature:removed → dispatches an add
    await map.test.flush()

    expect(history.depth).toBe(0)
    expect(history.canRedo).toBe(true)
    expect(map.store.collection('audit').size).toBe(1)
  })
})

/* ========================================================================= */
/* Gesture-scoped coalescing: a gesture is not a stopwatch                   */
/* ========================================================================= */

/**
 * Stands in for the edit plugin's `MoveVerticesCommand` — history must not import a
 * plugin, so the shape is reproduced here: it names the pointer gesture it belongs
 * to, its target is absolute (every frame recomputes from the original), and its
 * `coalesceWith` merges only *within* one gesture.
 */
class GestureTranslateCommand implements Command<void> {
  readonly type = 'test:gesture-translate'
  readonly label = 'Move parcel'
  readonly gesture: string

  readonly #id: string
  readonly #east: number
  #previous: readonly BlaeuFeature[] | undefined
  #written: readonly BlaeuFeature[] | undefined

  constructor(id: string, east: number, gesture: string) {
    this.#id = id
    this.#east = east
    this.gesture = gesture
  }

  execute(ctx: CommandContext): void {
    this.#previous ??= [ctx.store.find(this.#id)!]
    const next = this.#written ?? this.#previous.map((f) => translated(f, this.#east, 0))
    this.#written = ctx.store._update(next)
  }

  undo(ctx: CommandContext): void {
    if (this.#previous !== undefined) ctx.store._update(this.#previous)
  }

  coalesceWith(previous: Command): Command | null {
    if (!(previous instanceof GestureTranslateCommand)) return null
    if (previous.gesture !== this.gesture) return null
    const merged = new GestureTranslateCommand(this.#id, this.#east, this.gesture)
    merged.#previous = previous.#previous
    merged.#written = this.#written
    return merged
  }
}

describe('coalescing a gesture', () => {
  /**
   * The regression this guards: a surveyor drags a parcel corner, pauses longer than
   * `coalesceWindowMs` to read the coordinate readout, then nudges it home — one
   * gesture, button never released. History used to refuse to even *ask* the command
   * once its stopwatch expired, so that drag became two undo entries and the first
   * Ctrl+Z stranded the geometry at a mid-drag position the user never dropped it at.
   */
  it('merges frames of one gesture even when they straddle the coalesce window', async () => {
    const map = await mapWithHistory({ coalesceWindowMs: 300 })
    const history = map.plugin('history')
    const before = map.store.snapshot()

    map.commands.dispatch(new GestureTranslateCommand('seed-1', 1, 'drag-1'))

    // The pause: drive the second frame through the real bus, but with the wall clock
    // advanced well past the window. No sleep, no flake.
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 5_000)
    map.commands.dispatch(new GestureTranslateCommand('seed-1', 2, 'drag-1'))
    spy.mockRestore()

    // One gesture, one undo step — the wall clock does not get a vote.
    expect(history.depth).toBe(1)

    // And that one undo goes all the way back to before the gesture began.
    expect(history.undo()).toBe(true)
    expect(map.store.snapshot()).toEqual(before)
  })

  it('still never merges two different gestures, however fast they arrive', async () => {
    const map = await mapWithHistory({ coalesceWindowMs: 300 })
    const history = map.plugin('history')

    map.commands.dispatch(new GestureTranslateCommand('seed-1', 1, 'drag-1'))
    map.commands.dispatch(new GestureTranslateCommand('seed-1', 2, 'drag-2'))

    expect(history.depth).toBe(2)
  })

  it('honours coalesceWindowMs: 0 — merging off means off, gesture or not', async () => {
    const map = await mapWithHistory({ coalesceWindowMs: 0 })
    const history = map.plugin('history')

    map.commands.dispatch(new GestureTranslateCommand('seed-1', 1, 'drag-1'))
    map.commands.dispatch(new GestureTranslateCommand('seed-1', 2, 'drag-1'))

    expect(history.depth).toBe(2)
  })
})

/* ========================================================================= */
/* API surface                                                               */
/* ========================================================================= */

describe('api', () => {
  it('reports labels, depth and clears', async () => {
    const map = await mapWithHistory()
    const history = map.plugin('history')

    expect(history.canUndo).toBe(false)
    expect(history.undoLabel).toBeUndefined()
    expect(history.undo()).toBe(false)
    expect(history.redo()).toBe(false)

    await map.commands.commit(
      new AddFeaturesCommand('parcels', [newParcel(1)], { label: 'Draw parcel' }),
    )

    expect(history.undoLabel).toBe('Draw parcel')
    expect(history.redoLabel).toBeUndefined()

    history.undo()
    expect(history.redoLabel).toBe('Draw parcel')

    history.clear()
    expect(history.depth).toBe(0)
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
  })

  it('emits history:changed and notifies onChange subscribers', async () => {
    const map = await mapWithHistory()
    const history = map.plugin('history')

    const events: { canUndo: boolean; canRedo: boolean; depth: number }[] = []
    map.events.on('history:changed', (event) => events.push({ ...event.payload }))

    let calls = 0
    const subscription = history.onChange(() => calls++)

    await map.commands.commit(new AddFeaturesCommand('parcels', [newParcel(1)]))
    history.undo()

    expect(events).toEqual([
      { canUndo: true, canRedo: false, depth: 1 },
      { canUndo: false, canRedo: true, depth: 0 },
    ])
    expect(calls).toBe(2)

    subscription.dispose()
    await map.commands.commit(new AddFeaturesCommand('parcels', [newParcel(2)]))
    expect(calls).toBe(2)
  })

  it('survives a command whose undo throws, and keeps the map usable', async () => {
    const map = await mapWithHistory()
    const history = map.plugin('history')

    const errors: string[] = []
    map.events.on('map:error', (event) => errors.push(event.payload.source))

    map.commands.dispatch(new BadUndoCommand())

    expect(history.depth).toBe(1)
    expect(history.undo()).toBe(false)
    // The stack is unchanged, so the user can still undo whatever is beneath it once
    // the offending command is fixed — and nothing was half-applied.
    expect(history.depth).toBe(1)
    expect(errors).toEqual(['history:undo'])
  })

  it('rejects a nonsensical limit with an actionable message', () => {
    expect(() => historyPlugin({ limit: 0 })).not.toThrow() // the factory is pure
    return expect(createTestMap({ plugins: [historyPlugin({ limit: 0 })] })).rejects.toThrow(
      /limit must be a finite number >= 1/,
    )
  })
})

/* ========================================================================= */
/* Keyboard                                                                  */
/* ========================================================================= */

describe('keyboard', () => {
  it('binds Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y on a non-mac platform', () => {
    const target = new FakeKeyTarget()
    const history = new FakeHistory()
    const binding = bindKeyboard(target, history, false)

    target.press({ key: 'z', ctrlKey: true })
    expect(history.calls).toEqual(['undo'])

    target.press({ key: 'z', ctrlKey: true, shiftKey: true })
    target.press({ key: 'y', ctrlKey: true })
    expect(history.calls).toEqual(['undo', 'redo', 'redo'])

    // Cmd on Windows is not a modifier we own.
    target.press({ key: 'z', metaKey: true })
    expect(history.calls).toHaveLength(3)

    binding.dispose()
    target.press({ key: 'z', ctrlKey: true })
    expect(history.calls).toHaveLength(3)
    expect(target.listeners).toBe(0)
  })

  it('uses Cmd on macOS, and leaves Cmd+Y alone', () => {
    const target = new FakeKeyTarget()
    const history = new FakeHistory()
    bindKeyboard(target, history, true)

    target.press({ key: 'z', ctrlKey: true })
    expect(history.calls).toEqual([])

    target.press({ key: 'z', metaKey: true })
    target.press({ key: 'z', metaKey: true, shiftKey: true })
    target.press({ key: 'y', metaKey: true })
    expect(history.calls).toEqual(['undo', 'redo'])
  })

  it('never fires while the user is typing', () => {
    const target = new FakeKeyTarget()
    const history = new FakeHistory()
    bindKeyboard(target, history, false)

    target.press({ key: 'z', ctrlKey: true, target: { tagName: 'INPUT' } })
    target.press({ key: 'z', ctrlKey: true, target: { tagName: 'textarea' } })
    target.press({ key: 'z', ctrlKey: true, target: { isContentEditable: true } })

    expect(history.calls).toEqual([])
  })

  it('claims the chord even when there is nothing to undo', () => {
    const target = new FakeKeyTarget()
    const history = new FakeHistory()
    bindKeyboard(target, history, false)

    const event = target.press({ key: 'z', ctrlKey: true })
    expect(event.prevented).toBe(true)

    const ignored = target.press({ key: 'a', ctrlKey: true })
    expect(ignored.prevented).toBe(false)
  })
})

/* ========================================================================= */
/* Test doubles                                                              */
/* ========================================================================= */

interface FakeKeyInit {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  target?: unknown
}

class FakeKeyTarget implements KeyboardTarget {
  #handlers: ((event: Event) => void)[] = []

  get listeners(): number {
    return this.#handlers.length
  }

  addEventListener(_type: string, handler: (event: Event) => void): void {
    this.#handlers.push(handler)
  }

  removeEventListener(_type: string, handler: (event: Event) => void): void {
    const i = this.#handlers.indexOf(handler)
    if (i >= 0) this.#handlers.splice(i, 1)
  }

  press(init: FakeKeyInit): { prevented: boolean } {
    const state = { prevented: false }
    const event = {
      key: init.key,
      ctrlKey: init.ctrlKey ?? false,
      metaKey: init.metaKey ?? false,
      shiftKey: init.shiftKey ?? false,
      altKey: init.altKey ?? false,
      target: init.target ?? null,
      preventDefault: () => {
        state.prevented = true
      },
    } as unknown as Event

    for (const handler of [...this.#handlers]) handler(event)
    return state
  }
}

class FakeHistory {
  readonly calls: string[] = []

  undo(): boolean {
    this.calls.push('undo')
    return true
  }

  redo(): boolean {
    this.calls.push('redo')
    return true
  }

  readonly canUndo = false
  readonly canRedo = false
  readonly undoLabel = undefined
  readonly redoLabel = undefined
  readonly depth = 0

  clear(): void {}

  onChange(): { dispose: () => void } {
    return { dispose: () => {} }
  }
}

/** A hover preview. Executes, changes nothing durable, and must never be undoable. */
class PreviewCommand implements Command<void> {
  readonly type = 'test:preview'
  readonly transient = true
  execute(): void {}
  undo(): void {}
}

/** The command every history plugin meets eventually. */
class BadUndoCommand implements Command<void> {
  readonly type = 'test:bad-undo'
  readonly label = 'Broken'
  execute(_ctx: CommandContext): void {}
  undo(_ctx: CommandContext): void {
    throw new Error('undo is not implemented, which is the bug this test is about')
  }
}
