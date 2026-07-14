/**
 * The commit pipeline actually runs on the write path.
 *
 * This file exists because for a while it did not. `AsyncCommitPipeline` was
 * constructed by the kernel, preset middleware was registered into it, the
 * validation registry installed itself into it — and nothing ever called `run()`.
 * Every one of those parts had tests. Every test passed. The parts were correct and
 * the wire between them did not exist, so the whole library quietly had *no
 * validation*: a rule could be registered, would never be consulted, and the only
 * symptom was a rule that never fired, which looks exactly like a rule with nothing
 * to complain about.
 *
 * The lesson is the one this suite is now built around: a test that exercises a
 * middleware by constructing a context and calling the middleware **tests the
 * middleware, not the wiring**. Every test below goes through the public API —
 * `map.commands.commit(...)` — and asserts on `map.store`, because the store is the
 * only thing that cannot lie about whether the write happened.
 */

import { describe, expect, it } from 'vitest'

import { createTestMap } from '../testing/createTestMap.js'
import { AddFeaturesCommand, RemoveFeaturesCommand, UpdateFeaturesCommand } from './builtins.js'
import type { CommitMiddleware } from '../types/pipeline.js'
import type { FlexiFeature } from '../types/feature.js'

const SQUARE = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [32.85, 39.92],
      [32.851, 39.92],
      [32.851, 39.921],
      [32.85, 39.921],
      [32.85, 39.92],
    ],
  ],
}

describe('the commit pipeline runs on the write path', () => {
  it('a validation rule vetoes the write, and nothing reaches the store', async () => {
    const map = await createTestMap()

    map.validation.add({
      id: 'test:no-squares',
      severity: 'error',
      check: (feature) =>
        feature.geometry.type === 'Polygon'
          ? [{ rule: 'test:no-squares', feature: feature.id, severity: 'error', message: 'no' }]
          : [],
    })

    const result = await map.commands.commit(
      new AddFeaturesCommand('parcels', [{ geometry: SQUARE }]),
    )

    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toContain('no')
    // The whole point. Before the fix, this was 1.
    expect(map.store.collection('parcels').all()).toHaveLength(0)

    map.destroy()
  })

  it('a rejected write leaves no trace at all — no id, no event, no topology entry', async () => {
    const map = await createTestMap()
    const added: FlexiFeature[] = []
    map.events.on('feature:added', (e) => added.push(...e.payload.features))

    map.validation.add({
      id: 'test:refuse',
      severity: 'error',
      check: (feature) => [
        { rule: 'test:refuse', feature: feature.id, severity: 'error', message: 'refused' },
      ],
    })

    const before = map.store.snapshot()
    await map.commands.commit(new AddFeaturesCommand('parcels', [{ geometry: SQUARE }]))

    // `materialise` mints an id in order to show the rule what it is judging. That id
    // must not survive the rejection: if it lingered in the store's owner index, the
    // next attempt to add the same feature would be refused as a duplicate — a bug
    // whose symptom is "I fixed the parcel and now it says it already exists".
    expect(map.store.snapshot()).toEqual(before)
    expect(added).toHaveLength(0)
    expect(map.debug.snapshot().features).toBe(0)

    map.destroy()
  })

  it('middleware rewrites what lands — the store holds the rewritten feature, not the input', async () => {
    const map = await createTestMap()

    const stamp: CommitMiddleware = async (ctx, next) => {
      ctx.features = ctx.features.map((f) => ({
        ...f,
        properties: { ...f.properties, stamped: true },
      }))
      await next()
    }
    map.commit.use(stamp, { id: 'test:stamp' })

    const result = await map.commands.commit(
      new AddFeaturesCommand('parcels', [{ geometry: SQUARE, properties: { stamped: false } }]),
    )

    expect(result.ok).toBe(true)
    // Not `result.value` — the store. A command that reported the rewrite but wrote
    // the original would pass an assertion on the return value and still be wrong.
    const [stored] = map.store.collection('parcels').all()
    expect(stored?.properties['stamped']).toBe(true)

    map.destroy()
  })

  it('a rule can veto an update — an edit that breaks a parcel is refused, and the old one survives intact', async () => {
    const map = await createTestMap()

    const add = await map.commands.commit(new AddFeaturesCommand('parcels', [{ geometry: SQUARE }]))
    const parcel = add.value?.[0]
    expect(parcel).toBeDefined()

    map.validation.add({
      id: 'test:frozen',
      severity: 'error',
      check: (feature) =>
        feature.properties['locked'] === true
          ? [{ rule: 'test:frozen', feature: feature.id, severity: 'error', message: 'locked' }]
          : [],
    })

    const before = map.store.find(parcel!.id)
    const result = await map.commands.commit(
      new UpdateFeaturesCommand([{ ...parcel!, properties: { locked: true } }]),
    )

    expect(result.ok).toBe(false)
    expect(map.store.find(parcel!.id)).toEqual(before)

    map.destroy()
  })

  it('a removal is NOT validated — you can always delete an already-invalid parcel', async () => {
    const map = await createTestMap()

    const add = await map.commands.commit(new AddFeaturesCommand('parcels', [{ geometry: SQUARE }]))
    const id = add.value?.[0]?.id
    expect(id).toBeDefined()

    // Registered *after* the add, and it refuses everything. A data steward cleaning up
    // a bad import must still be able to delete the mess; a validator that blocks
    // removal makes an invalid feature immortal.
    map.validation.add({
      id: 'test:refuse-all',
      severity: 'error',
      check: (feature) => [
        { rule: 'test:refuse-all', feature: feature.id, severity: 'error', message: 'no' },
      ],
    })

    const result = await map.commands.commit(new RemoveFeaturesCommand([id!]))

    expect(result.ok).toBe(true)
    expect(map.store.collection('parcels').all()).toHaveLength(0)

    map.destroy()
  })

  it('middleware that throws fails CLOSED — a broken validator refuses the write, it does not wave it through', async () => {
    const map = await createTestMap()

    map.commit.use(
      async () => {
        throw new Error('the topology service is down')
      },
      { id: 'test:explode' },
    )

    const result = await map.commands.commit(
      new AddFeaturesCommand('parcels', [{ geometry: SQUARE }]),
    )

    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toContain('topology service is down')
    expect(map.store.collection('parcels').all()).toHaveLength(0)

    map.destroy()
  })

  it('dispatch() refuses a feature-writing command at runtime, so validation cannot be skipped by accident', async () => {
    const map = await createTestMap()

    // The compiler already rejects this; the cast is what a JavaScript caller — or a
    // determined one — would end up doing. It must still fail, and loudly.
    const bus = map.commands as unknown as { dispatch(c: unknown): unknown }

    expect(() => bus.dispatch(new AddFeaturesCommand('parcels', [{ geometry: SQUARE }]))).toThrow(
      /must go through commands\.commit\(\)/,
    )
    expect(map.store.collection('parcels').all()).toHaveLength(0)

    map.destroy()
  })

  it('a veto inside commitTransaction rolls back the whole group — no half-applied split', async () => {
    const map = await createTestMap()

    const add = await map.commands.commit(new AddFeaturesCommand('parcels', [{ geometry: SQUARE }]))
    const id = add.value?.[0]?.id
    expect(id).toBeDefined()
    const before = map.store.snapshot()

    // Refuse anything carrying `half: true` — i.e. the two halves of the split, but
    // not the removal of the original.
    map.validation.add({
      id: 'test:no-halves',
      severity: 'error',
      appliesTo: (feature) => feature.properties['half'] === true,
      check: (feature) => [
        { rule: 'test:no-halves', feature: feature.id, severity: 'error', message: 'too small' },
      ],
    })

    const result = await map.commands.commitTransaction('Split', async () => {
      await map.commands.commit(new RemoveFeaturesCommand([id!]))
      await map.commands.commit(
        new AddFeaturesCommand('parcels', [
          { geometry: SQUARE, properties: { half: true } },
          { geometry: SQUARE, properties: { half: true } },
        ]),
      )
    })

    expect(result.ok).toBe(false)
    // The original parcel is still there. The failure mode this guards against is the
    // one that matters: the removal succeeded, the halves were refused, and the
    // surveyor is left with a hole where their land used to be.
    expect(map.store.snapshot()).toEqual(before)
    expect(map.store.find(id!)).toBeDefined()

    map.destroy()
  })

  it('an in-flight fire-and-forget commit does not land inside someone else’s undo group', async () => {
    const map = await createTestMap()
    const groups: (string | null)[] = []
    map.commands.onDidExecute((_cmd, transaction) => groups.push(transaction))

    // The delays are what make this test discriminating, so they are worth spelling out.
    // The stray write is SHORTER than the transaction's, so that — without a queue — the
    // stray resumes from its `await` while the transaction is still open, looks at
    // `#transaction`, and finds one that is not its own.
    //
    // Get this backwards (stray slower than the transaction) and the test passes whether
    // or not the bug is present, because the transaction has already closed by the time
    // the stray resumes. That is the vacuous version of this test, and it is easy to
    // write by accident.
    map.commit.use(
      async (ctx, next) => {
        const ms = ctx.features[0]?.meta.collection === 'stray' ? 5 : 40
        await new Promise((r) => setTimeout(r, ms))
        await next()
      },
      { id: 'test:slow' },
    )

    // Fire and forget — exactly how a tool calls it.
    void map.commands.commit(new AddFeaturesCommand('stray', [{ geometry: SQUARE }]))

    await map.commands.commitTransaction('Group', async () => {
      await map.commands.commit(new AddFeaturesCommand('grouped', [{ geometry: SQUARE }]))
    })

    await map.test.flush()

    // Two separate history entries, in call order. Before the write path was serialised
    // the stray commit resumed mid-transaction and was recorded as a *child* of "Group",
    // so this array was `['Group']` — one entry — and one Ctrl-Z would have undone the
    // stray write together with the group. Nothing in the store looked wrong, which is
    // exactly why no existing test caught it.
    expect(groups).toEqual([null, 'Group'])
    expect(map.store.collection('stray').all()).toHaveLength(1)
    expect(map.store.collection('grouped').all()).toHaveLength(1)

    map.destroy()
  })

  it('committed features route to the collection their own meta names, not the command’s', async () => {
    const map = await createTestMap()

    // A generator-style middleware that appends a feature belonging somewhere else.
    const scatter: CommitMiddleware = async (ctx, next) => {
      if (ctx.operation === 'add' && ctx.features.length === 1) {
        ctx.features.push(
          ...map.store.materialise('decor', [
            { geometry: { type: 'Point', coordinates: [32.8505, 39.9205] } },
          ]),
        )
      }
      await next()
    }
    map.commit.use(scatter, { id: 'test:scatter' })

    const result = await map.commands.commit(
      new AddFeaturesCommand('entities', [{ geometry: SQUARE }]),
    )

    expect(result.ok).toBe(true)
    expect(map.store.collection('entities').all()).toHaveLength(1)
    expect(map.store.collection('decor').all()).toHaveLength(1)

    map.destroy()
  })
})
