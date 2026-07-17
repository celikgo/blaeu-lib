import { describe, expect, it } from 'vitest'
import type { Polygon, Position } from 'geojson'

import { BlaeuEventBus } from '../events/EventBus.js'
import { BlaeuCommandBus } from './CommandBus.js'
import { AsyncCommitPipeline } from '../pipeline/Pipeline.js'
import { BlaeuFeatureStore } from '../store/FeatureStore.js'
import { createTestCrs, offsetMetres } from '../store/test-crs.js'
import {
  AddFeaturesCommand,
  RemoveFeaturesCommand,
  SetPropertiesCommand,
  UpdateFeaturesCommand,
} from './builtins.js'
import type { CrsService } from '../types/crs.js'
import type { LngLat } from '../types/common.js'
import type { Command, CommandContext } from '../types/command.js'

const ANKARA: LngLat = [32.85, 39.93]

function setup() {
  const crs = createTestCrs()
  const events = new BlaeuEventBus()
  const store = new BlaeuFeatureStore(crs, events, { strict: true })
  // A real pipeline, with no middleware in it. The bus runs every durable write through
  // this; a bus built without one cannot commit at all.
  const commit = new AsyncCommitPipeline()
  const commands = new BlaeuCommandBus(store, events, commit)
  const ctx: CommandContext = { store, events }
  return { crs, events, store, commit, commands, ctx }
}

function rect(crs: CrsService, origin: LngLat, size = 20): Polygon {
  const corner = (dx: number, dy: number): Position => [...offsetMetres(crs, origin, dx, dy)]
  return {
    type: 'Polygon',
    coordinates: [
      [corner(0, 0), corner(size, 0), corner(size, size), corner(0, size), corner(0, 0)],
    ],
  }
}

describe('AddFeaturesCommand', () => {
  it('adds, and undoes back to deep equality', async () => {
    const { crs, store, commands } = setup()
    const before = store.snapshot()

    const command = new AddFeaturesCommand('parcels', [{ geometry: rect(crs, ANKARA) }])
    const result = await commands.commit(command)

    expect(result.ok).toBe(true)
    expect(result.value).toHaveLength(1)
    expect(store.snapshot()).not.toEqual(before)

    commands._apply(command, 'undo')
    expect(store.snapshot()).toEqual(before)
  })

  it('keeps the same ids across undo and redo', () => {
    const { crs, store, ctx } = setup()
    const command = new AddFeaturesCommand('parcels', [{ geometry: rect(crs, ANKARA) }])

    const added = command.execute(ctx)
    const id = added[0]!.id
    const afterExecute = store.snapshot()

    command.undo(ctx)
    expect(store.collection('parcels').size).toBe(0)

    command.execute(ctx) // redo
    // A redo that minted a new id would strand every selection, label and later
    // command that referenced the old one.
    expect(store.find(id)).toBeDefined()
    expect(store.snapshot()).toEqual(afterExecute)
  })
})

describe('RemoveFeaturesCommand', () => {
  it('restores removed features exactly — id, geometry, version, createdAt', () => {
    const { crs, store, ctx } = setup()
    store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA) }])
    const before = store.snapshot()

    const command = new RemoveFeaturesCommand(['a'])
    command.execute(ctx)
    expect(store.collection('parcels').size).toBe(0)

    command.undo(ctx)
    expect(store.snapshot()).toEqual(before)
  })

  it('puts each feature back in the collection it came from, when a selection spans collections', () => {
    const { crs, store, ctx } = setup()
    store._add('parcels', [{ id: 'p', geometry: rect(crs, ANKARA) }])
    store._add('buildings', [{ id: 'b', geometry: rect(crs, ANKARA, 5) }])
    const before = store.snapshot()

    const command = new RemoveFeaturesCommand(['p', 'b'])
    command.execute(ctx)
    command.undo(ctx)

    expect(store.find('p')!.meta.collection).toBe('parcels')
    expect(store.find('b')!.meta.collection).toBe('buildings')
    expect(store.snapshot()).toEqual(before)
  })

  it('undoes cleanly when some of the ids were already gone', () => {
    const { crs, store, ctx } = setup()
    store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA) }])
    const before = store.snapshot()

    const command = new RemoveFeaturesCommand(['a', 'ghost'])
    expect(command.execute(ctx)).toHaveLength(1)
    command.undo(ctx)

    expect(store.snapshot()).toEqual(before)
  })
})

describe('UpdateFeaturesCommand', () => {
  it('bumps the version, and undo restores the one before it', () => {
    const { crs, store, ctx } = setup()
    const [parcel] = store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA) }])
    const before = store.snapshot()

    const moved = { ...parcel!, geometry: rect(crs, offsetMetres(crs, ANKARA, 5, 0)) }
    const command = new UpdateFeaturesCommand([moved])
    command.execute(ctx)

    expect(store.find('a')!.meta.version).toBe(2)
    expect(store.snapshot()).not.toEqual(before)

    command.undo(ctx)
    expect(store.snapshot()).toEqual(before)
    expect(store.find('a')!.meta.version).toBe(1)
  })

  it('reproduces the first execution exactly on redo', () => {
    const { crs, store, ctx } = setup()
    const [parcel] = store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA) }])

    const command = new UpdateFeaturesCommand([
      { ...parcel!, geometry: rect(crs, offsetMetres(crs, ANKARA, 5, 0)) },
    ])
    command.execute(ctx)
    const afterExecute = store.snapshot()

    command.undo(ctx)
    command.execute(ctx)

    expect(store.snapshot()).toEqual(afterExecute)
  })

  it('fails actionably on an id the store has never seen', () => {
    const { crs, store, ctx } = setup()
    const [parcel] = store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA) }])
    const command = new UpdateFeaturesCommand([{ ...parcel!, id: 'ghost' }])

    expect(() => command.execute(ctx)).toThrow(/not in the store/)
  })
})

describe('SetPropertiesCommand', () => {
  it('merges the patch and undoes to deep equality', () => {
    const { crs, store, ctx } = setup()
    store._add('parcels', [
      { id: 'a', geometry: rect(crs, ANKARA), properties: { ada: '100', parsel: '5' } },
    ])
    const before = store.snapshot()

    const command = new SetPropertiesCommand(['a'], { ada: '101' })
    command.execute(ctx)

    expect(store.find('a')!.properties).toEqual({ ada: '101', parsel: '5' })

    command.undo(ctx)
    expect(store.snapshot()).toEqual(before)
  })

  it('removes a key set to undefined — what an attribute editor means by "cleared"', () => {
    const { crs, store, ctx } = setup()
    store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA), properties: { ada: '100' } }])

    new SetPropertiesCommand(['a'], { ada: undefined }).execute(ctx)
    expect(store.find('a')!.properties).toEqual({})
  })

  it('coalesces a burst of keystrokes into one undo step', () => {
    const { crs, store, ctx } = setup()
    store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA), properties: { ada: '' } }])
    const before = store.snapshot()

    // Typing "100": three commands, three executions, one gesture.
    const first = new SetPropertiesCommand(['a'], { ada: '1' })
    first.execute(ctx)
    const second = new SetPropertiesCommand(['a'], { ada: '10' })
    second.execute(ctx)
    const third = new SetPropertiesCommand(['a'], { ada: '100' })
    third.execute(ctx)

    const merged = third.coalesceWith(second.coalesceWith(first)!)
    expect(merged).not.toBeNull()

    merged!.undo(ctx)

    // One Ctrl-Z, and the field is back to what it was before the first keystroke —
    // not back to "10".
    expect(store.find('a')!.properties['ada']).toBe('')
    expect(store.snapshot()).toEqual(before)
  })

  it('redoes a coalesced edit to the final text', () => {
    const { crs, store, ctx } = setup()
    store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA), properties: { ada: '' } }])

    const first = new SetPropertiesCommand(['a'], { ada: '1' })
    first.execute(ctx)
    const second = new SetPropertiesCommand(['a'], { ada: '10' })
    second.execute(ctx)

    const merged = second.coalesceWith(first)!
    merged.undo(ctx)
    merged.execute(ctx)

    expect(store.find('a')!.properties['ada']).toBe('10')
  })

  it('does not coalesce across different features or different fields', () => {
    const { crs, store, ctx } = setup()
    store._add('parcels', [
      { id: 'a', geometry: rect(crs, ANKARA), properties: {} },
      { id: 'b', geometry: rect(crs, offsetMetres(crs, ANKARA, 50, 0)), properties: {} },
    ])

    const onA = new SetPropertiesCommand(['a'], { ada: '1' })
    onA.execute(ctx)
    const onB = new SetPropertiesCommand(['b'], { ada: '2' })
    onB.execute(ctx)
    expect(onB.coalesceWith(onA)).toBeNull()

    // Tabbing to the next field is a new edit: one Ctrl-Z must not wipe the field the
    // user had already finished with.
    const otherField = new SetPropertiesCommand(['a'], { parsel: '9' })
    otherField.execute(ctx)
    expect(otherField.coalesceWith(onA)).toBeNull()
  })

  it('does not coalesce with a command of another kind', () => {
    const { crs, store, ctx } = setup()
    const [parcel] = store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA) }])
    const update = new UpdateFeaturesCommand([parcel!])
    const set = new SetPropertiesCommand(['a'], { ada: '1' })
    set.execute(ctx)

    expect(set.coalesceWith(update)).toBeNull()
  })

  it('opts out of coalescing when the window is zero', () => {
    const { crs, store, ctx } = setup()
    store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA), properties: {} }])

    const first = new SetPropertiesCommand(['a'], { locked: true }, { coalesceWindowMs: 0 })
    first.execute(ctx)
    const second = new SetPropertiesCommand(['a'], { locked: false }, { coalesceWindowMs: 0 })
    second.execute(ctx)

    expect(second.coalesceWith(first)).toBeNull()
  })
})

describe('the command bus, end to end', () => {
  it('rolls a failed transaction back to deep equality', async () => {
    const { crs, store, commands } = setup()
    store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA) }])
    const before = store.snapshot()

    const result = await commands.commitTransaction('Split parcel', async () => {
      await commands.commit(new RemoveFeaturesCommand(['a']))
      await commands.commit(
        new AddFeaturesCommand('parcels', [
          { geometry: rect(crs, offsetMetres(crs, ANKARA, 30, 0)) },
        ]),
      )
      throw new Error('the registry rejected the split')
    })

    expect(result.ok).toBe(false)
    expect(store.snapshot()).toEqual(before)
  })

  it('undoes a whole transaction as one step', async () => {
    const { crs, store, commands } = setup()
    store._add('parcels', [{ id: 'a', geometry: rect(crs, ANKARA) }])
    const before = store.snapshot()

    // Stand in for the history plugin, which is the real owner of the undo stack.
    let composite: Command | undefined
    const off = commands.onDidExecute((command) => {
      composite = command
    })

    await commands.commitTransaction('Split parcel', async () => {
      await commands.commit(new RemoveFeaturesCommand(['a']))
      await commands.commit(
        new AddFeaturesCommand('parcels', [
          { id: 'a1', geometry: rect(crs, ANKARA, 10) },
          { id: 'a2', geometry: rect(crs, offsetMetres(crs, ANKARA, 10, 0), 10) },
        ]),
      )
    })
    off.dispose()

    expect(store.collection('parcels').size).toBe(2)
    commands._apply(composite!, 'undo')
    expect(store.snapshot()).toEqual(before)
  })

  /**
   * Regression: a transaction whose children are *all* transient used to announce a
   * `CompositeCommand` with an empty `children` array — an undo entry whose `undo()`
   * is a no-op. The history plugin recorded it, and the user's next Ctrl-Z was
   * silently swallowed undoing nothing.
   */
  it('does not record an undo entry for a transaction with only transient children', () => {
    const { crs, store, commands } = setup()

    class PreviewCommand implements Command<void> {
      readonly type = 'test:preview'
      readonly label = 'Preview'
      readonly transient = true
      #added: readonly string[] = []
      execute(ctx: CommandContext): void {
        this.#added = ctx.store
          ._add('preview', [{ geometry: rect(crs, ANKARA) }])
          .map((feature) => feature.id)
      }
      undo(ctx: CommandContext): void {
        ctx.store._remove(this.#added)
      }
    }

    const announced: Command[] = []
    const off = commands.onDidExecute((command) => announced.push(command))

    const result = commands.transaction('Rubber band', () => {
      commands.dispatch(new PreviewCommand())
    })
    off.dispose()

    expect(result.ok).toBe(true)
    // The transient command really did run — it is the *recording* we object to.
    expect(store.collection('preview').size).toBe(1)
    expect(announced).toEqual([])
  })

  it('collapses a transaction to its single recordable command, ignoring transient ones', async () => {
    const { crs, store, commands } = setup()

    class PreviewCommand implements Command<void> {
      readonly type = 'test:preview'
      readonly label = 'Preview'
      readonly transient = true
      execute(): void {}
      undo(): void {}
    }

    const announced: Command[] = []
    const off = commands.onDidExecute((command) => announced.push(command))

    await commands.commitTransaction('Draw polygon', async () => {
      commands.dispatch(new PreviewCommand())
      await commands.commit(new AddFeaturesCommand('parcels', [{ geometry: rect(crs, ANKARA) }]))
    })
    off.dispose()

    expect(announced).toHaveLength(1)
    // The real command, not a CompositeCommand wrapping it — so the undo menu reads
    // "Add feature" rather than "Transaction", and one Ctrl-Z undoes one thing.
    expect(announced[0]!.type).toBe('core:add-features')

    commands._apply(announced[0]!, 'undo')
    expect(store.collection('parcels').size).toBe(0)
  })
})
