# ADR 0009 — Durable writes are `CommitCommand`s, and `dispatch()` refuses them

Status: accepted
Supersedes the open question left by [ADR 0004](./0004-sync-interaction-async-commit.md).

## Context

BlaeuMap had two pipelines by design: a synchronous one for pointer events, and an
asynchronous one for writes, where a validation rule may veto and a preset's middleware may
rewrite what lands. [ADR 0004](./0004-sync-interaction-async-commit.md) argued for that
split and still does.

The asynchronous half was never connected.

`BlaeuMap` constructed an `AsyncCommitPipeline`. It registered the preset's commit middleware
into it. `ValidationRegistry.asCommitMiddleware()` installed itself into it. `BlaeuMap.debug`
exposed it. And no code path in the kernel ever called `pipeline.run()`. The only production
caller in the entire repository was `preset-game`'s `EntitySession.place()`, which built its
own `CommitContext` by hand — a local workaround for a kernel gap, which is precisely why the
gap survived: the one place that needed the pipeline had quietly stopped needing the kernel.

The consequences were not subtle, and none of them were visible as a failing test:

- **No validation rule could veto any write.** Rules were registered, never consulted. A rule
  that never fires is indistinguishable from a rule with nothing to complain about.
- **The cadastre preset's `deriveAreaMiddleware` was correct and dead.** A parcel's
  `yüzölçümü` was therefore whatever the caller typed, and it survived arbitrary edits to the
  geometry. In the reproduction, the deed said 2000 m² for a parcel that was 8012 m².
- Every part had tests, and every test passed, because each test constructed a middleware and
  invoked it directly. **That tests the middleware. It does not test the wiring.**

The cause was a genuine design tension, not carelessness. `CommandBus.dispatch()` is
synchronous — it runs on `pointermove`, up to 120 times a second — and the commit pipeline is
asynchronous, because a real cadastral overlap check is a round-trip to a parcel registry.
Something had to give.

## Decision

**Split the write path in two, and make the type system enforce which one you are on.**

A command that writes durable features implements `CommitCommand`, which adds two members to
`Command`:

```ts
interface CommitCommand<R = void> extends Command<R> {
  /** What is about to be written — real ids, geometry already normalised. */
  intent(ctx: CommandContext): CommitIntent
  /** Take what the middleware chain produced, and write *that*. */
  adopt(features: readonly BlaeuFeature[]): void
}
```

and the bus grows an asynchronous counterpart:

```ts
dispatch<R>(command: Command<R> & { intent?: never }): DispatchResult<R>   // sync, no pipeline
commit<R>(command: CommitCommand<R>): Promise<DispatchResult<R>>           // async, pipeline
commitTransaction(label: string, fn: () => Promise<void>): Promise<DispatchResult<void>>
```

The `intent?: never` is the load-bearing part. **`dispatch()` will not compile if you hand it
a feature-writing command**, and it throws at runtime for JavaScript callers. If the way to
skip validation were "call the other method", then skipping validation would be one typo away,
and every product built on this library would eventually ship a write path that no rule
guards. That is the bug we just spent a day finding; we are not leaving the door open behind
us.

`CommitIntent.features` are **materialised, not written**: `FeatureStore.materialise()` mints
ids, stamps meta, winds rings and quantises coordinates to the working CRS's grid, and writes
nothing. A rule therefore judges the parcel that will actually exist. A rule that passed on
the raw input but would have failed on the stored feature is not a weak rule — it is a lie.

## What stays on `dispatch()`, and why that is not a loophole

Not every store write should be validated. A drag preview, a vertex handle, a snap indicator,
a hover highlight — these live in the store because that is where the renderer reads from, and
running a JSTS topology check on them at 120 Hz would be both slow and wrong: geometry is
_legitimately_ invalid halfway through a drag. Those stay synchronous, transient, and
unvalidated.

The rule of thumb is **if it survives the gesture, it commits.** A rubber band does not. A
parcel does.

## Consequences

- **Good.** Validation rules veto writes. A rejected write leaves no trace at all: no minted
  id in the owner index, no `feature:added` event, no topology-index entry — verified, because
  a lingering id would make the next attempt to add the corrected parcel fail as a duplicate,
  and the user would see "I fixed it and now it says it already exists".
- **Good.** Middleware rewrites are not advisory. `deriveAreaMiddleware` now stamps the real
  planar area on the way in, so the attribute cannot disagree with the geometry.
- **Good.** A broken validator fails **closed**. A middleware that throws rejects the write. A
  topology service being down must not become a licence to write unchecked geometry into a
  land registry.
- **Good.** `commitTransaction` rolls the whole group back when any member is vetoed, so a
  split whose halves are refused cannot leave the original parcel deleted with nothing in its
  place. That is the worst outcome available and it is now unreachable.
- **Good.** `AddFeaturesCommand` routes each feature to the collection its own `meta` names,
  falling back to the command's. Commit middleware may therefore _add_ features that belong
  elsewhere — the game preset's `scatterAround` answers one placed hut with four trees
  destined for `decor` — which was impossible when one command meant one collection.
- **Bad.** The durable-write API is asynchronous, so `draw.complete()`, `edit.split()`,
  `edit.merge()`, `measure.clear()`, `topology.fix()` and `entity.place()` all return promises
  now. Tool handlers stay synchronous and fire without awaiting (`void session.complete(...)`);
  the map updates on the resulting event.
- **Bad.** Tests that assert on the store after a simulated gesture must `await
map.test.flush()` first. That is the honest cost of a write path that can call a server, and
  the harness has always exposed the hook.
- **Bad.** Writes are serialised through a queue on the bus. `#transaction` is a single
  mutable field, and the moment writes became asynchronous it stopped being safe to read
  after an `await`: a fire-and-forget commit could resume inside a transaction that was not
  its own and be recorded as a child of it, so one Ctrl-Z would undo two unrelated things.
  The store looked correct throughout, which is why no assertion caught it. Serialising
  removes the interleaving instead of trying to detect it.
- **Bad.** History needed a new hook. Its re-entrancy guard was a synchronous flag, and an
  async echo of an undo (an audit-trail listener that commits a record when a feature is
  removed) lands after the flag has reset — so the echo would be pushed onto the undo stack
  _and_ would clear the redo stack the user had just earned. `CommandOrigin.replay` is
  captured when the command is **submitted**, not when it executes, and carried through.
- **Known gap, deliberately not papered over.** `plugin-edit`'s vertex drag and transform
  still write through the synchronous path (`GeometryEditCommand` is not a `CommitCommand`),
  because each `pointermove` re-writes the geometry and committing per frame would let writes
  land out of order. The correct shape is preview-during-drag, commit-on-release. Until it
  lands, **dragging a boundary vertex is not validated** — the drag works and is undoable, but
  no rule inspects the result, so a surveyor can still drag a parcel into self-intersection.
  For the cadastre preset that is the gesture that matters most. Stated here rather than in a
  commit message, because a known hole that is written down is a bug and a known hole that is
  not is a trap.

## The test that would have caught it

Not one that constructs a middleware and calls it. One that goes through the public API and
asserts on `map.store` — the only component that cannot lie about whether the write happened.

`packages/core/src/commands/commit.test.ts`.
