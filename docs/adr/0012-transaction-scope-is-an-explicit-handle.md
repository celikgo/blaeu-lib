# ADR 0012 — A transaction's membership is an explicit handle, not a bus-global flag

Status: accepted
Amends [ADR 0009](./0009-commit-commands.md).

## Context

`commitTransaction(label, fn)` grouped every `commit()` made inside `fn` into one undo step,
so a parcel split — remove one, add two — is a single Ctrl-Z. It knew which commits belonged to
the group by a single mutable field on the bus, `#transaction`: `commit()` checked "is a
transaction open?" and, if so, ran the command inline and filed it under the group.

A single mutable flag is safe only while writes are synchronous. They are not — a `commit()`
awaits the commit pipeline, and a validation middleware may await a server. So the flag was open
across every `await` inside `fn`, and **any** commit submitted during one of those gaps joined
the group, whether or not it had anything to do with it:

- A tool firing a commit on a pointer event while a split's server-side topology check was still
  awaiting had its write recorded as a child of the split. One Ctrl-Z then undid both, and if the
  split rolled back, the unrelated write was rolled back with it. Nothing in the store looked
  wrong, which is why no test caught it.

The veto that rolls a transaction back had the same shape of bug. It was recorded on a second bus
field, `#vetoed`, set by _any_ rejected commit — including a standalone one outside every
transaction. Nothing cleared it there, so a rejected standalone `commit()` left `#vetoed` set,
and the _next_ unrelated `commitTransaction` read the stale reason and silently rolled itself back.

Both are the same root cause: **transaction membership and its veto were global bus state, read
across `await` points, when they are properly a property of one call.** `AsyncLocalStorage` would
scope them to the call stack, but it does not exist in the browser this library targets.

## Decision

**The transaction hands `fn` an explicit handle; membership is what goes through the handle.**

```ts
await map.commands.commitTransaction('Split parcel', async (tx) => {
  await tx.commit(new RemoveFeaturesCommand([parcel.id]))
  await tx.commit(new AddFeaturesCommand('parcels', [left, right]))
})
```

- `tx.commit()` / `tx.dispatch()` run inline as children of _this_ transaction, collected into
  its own `OpenTransaction { label, children, vetoed }` — never a bus field.
- `commands.commit()` (the bus) now **always** takes a turn in the write queue. A commit fired
  while a transaction is open therefore waits behind it instead of slipping into it. Children do
  not deadlock against that queue because they never call the bus — they go through the handle,
  which runs them inline.
- A veto is recorded on the transaction it happened inside (`if (tx) tx.vetoed ??= reason`),
  across _both_ veto paths — the commit-pipeline rejection and the `before:command:execute` gate.
  A standalone commit records nothing; its rejection is answered by the `{ ok: false }` it returns.
- The synchronous `transaction(label, fn)` is unchanged. It keeps a `#syncTransaction` field
  because a synchronous callback cannot `await`, so two can never be open at once and the field
  cannot be read across a gap.

## Consequences

- **Both HIGH bugs are fixed, and proven.** Two regression tests — a commit fired during an open
  transaction stays a separate undo entry; a rejected standalone commit does not roll back the
  next transaction — were confirmed to fail against the reintroduced bugs. A third pins the newly
  scoped gate veto (a `before:command:execute` refusal of one child rolls the whole group back).
- **The `commitTransaction` callback signature changed** from `() => Promise<void>` to
  `(tx) => Promise<void>`. Pre-1.0, this is a clean break, not a shim. In-tree callers (edit
  split/merge, measure complete) and the tests were updated. A child that calls
  `commands.commit()` instead of `tx.commit()` now enqueues behind its own transaction and
  deadlocks — that is the price of making membership explicit, and it is a loud failure (a hang in
  a test) rather than the silent mis-grouping it replaces.
- **A known, documented edge remains — and it is a net improvement, not a regression to fix by
  breaking a contract.** `dispatch()` and the synchronous `transaction()` are synchronous by
  contract (previews, handles, the `pointermove` path) and cannot join the queue. So a
  _non-transient_ `dispatch()` — a rare, undoable dispatch such as a pre-validated scenario
  restore — that fires during an async transaction's `await` runs immediately, records its own
  history entry, and, if that transaction then rolls back, has its store write reverted by the
  wholesale `store.restore()` while its history entry survives. The clean fix (rolling back by
  undoing the transaction's own children instead of restoring the snapshot) would violate the
  contract that a rolled-back transaction is a revision-preserving no-op — the property the
  deep-equality rollback test enforces. So the guidance is stated instead, in `#enqueue`: an
  undoable state change should prefer `commit()` (queued, never interleaves); a non-transient
  `dispatch()` already swims against "if it survives the gesture, it commits." In the old design
  the same interleaving was _always_ mis-grouped into the transaction; the new design only
  desyncs it on the rare rollback, and gets the common (success) case right.
