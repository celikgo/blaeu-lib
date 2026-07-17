# ADR 0002 — Every mutation is a Command; history is a subscriber, not a core feature

Status: accepted

## Context

Undo is the feature users notice only when it is wrong. In an editing tool it is not a
convenience — a surveyor who cannot take back a mis-drag will not use the tool at all.

The hard part is not implementing undo. It is implementing undo _across plugins that have
never heard of each other_. The draw plugin adds a polygon; the edit plugin moves a vertex;
the topology plugin repairs a self-intersection; a plugin nobody has written yet does
something none of us anticipated. All four must land in one coherent stack, in the right
order, with one Ctrl+Z per user-visible action — without any of them importing any other.

The obvious implementations fail in specific, well-known ways:

- **Snapshot the whole store per action.** Simple, and it works right up until the store
  holds 50 000 parcels, at which point 200 undo steps is 10 million features in memory.
- **Diff the store after each action.** Now undo depends on a diff algorithm being correct
  for every geometry type anyone will ever add, and a plugin that adds a new one silently
  breaks undo for everyone.
- **Let each plugin implement its own undo.** Then Ctrl+Z means "undo the last thing _this_
  plugin did", the global stack is a lie, and undoing a draw after an edit undoes the wrong
  thing.

## Decision

**Every state change in BlaeuMap is a `Command`, and a `Command` is the only way state
changes.**

```ts
interface Command<R = void> {
  readonly type: string
  readonly label?: string // shown in the undo menu, already localised
  readonly transient?: boolean // executes, but is never recorded
  execute(ctx: CommandContext): R
  undo(ctx: CommandContext): void
  redo?(ctx: CommandContext): R
  coalesceWith?(previous: Command): Command | null
}
```

The contract is strict and stated plainly: **`undo(execute(s))` must restore `s` to deep
equality.** Not "close enough", not "visually identical". If your `undo` cannot restore deep
equality, the command captured too little state — capture more. Every command owes the
round-trip test.

The `CommandBus` holds **no undo stack**. It exposes `onDidExecute(handler)`. The history
plugin subscribes to that, keeps two stacks of `Command`s, and calls `undo()` on them. It
knows nothing about geometry, drawing, parcels or vertices.

Supporting machinery, each earning its place:

- `transaction(label, fn)` — everything dispatched inside `fn` becomes one atomic undo step,
  and a throw inside `fn` restores the store from a snapshot taken up front. A parcel split
  is _remove one, add two_; undoing it half-way would be worse than having no undo.
- `coalesceWith(previous)` — merges a 200-frame vertex drag into one entry. Without it, a
  drag costs 200 Ctrl+Zs, which no user will forgive.
- `transient` — a rubber-band preview executes but is never recorded. If it would be
  maddening to have to press Ctrl+Z past it, it is transient.

## Alternatives rejected

**A command bus that owns the undo stack.** One less plugin, and undo works out of the box.
Rejected because it forces every product to pay for undo: a read-only viewer, a kiosk, an
embedded thumbnail renderer all carry an undo stack they will never touch. More decisively,
it forecloses the interesting variants — a collaborative product needs a history that
respects _other people's_ commands (you may not undo my edit), and a server-backed product
needs one that reconciles with a remote log. As a subscriber, history is replaceable. As a
core feature, it is not.

**Event sourcing over a persistent store.** Genuinely attractive, and closer to what a
collaborative back end will want. Rejected _for now_ because it imposes an immutable-log
model on every plugin author, including one writing a throwaway internal tool, and because
the in-memory command stack is a strict subset of it: an event-sourced history plugin can be
written later, against the same `Command` interface, without touching the kernel. That is
the whole point of history being a subscriber.

**Undo via inverse-operation inference** (auto-derive `undo` from `execute`). Requires the
store to be a pure function of the command, which stops being true the moment a command
mints an id or stamps a timestamp. And an inferred inverse that is subtly wrong is far worse
than an explicit one you can test.

## Consequences

- **Good.** A plugin written by a stranger in three years gets Ctrl+Z for free by
  implementing `Command` and dispatching through the bus. No registration in history, no
  import of history, no coupling in either direction. This is the property the whole ADR
  exists to buy.
- **Good.** The command bus is exactly the seam a CRDT or an operational-transform layer
  would attach to (see ROADMAP). That is not luck: a stream of typed, reversible,
  serialisable operations with a stable `type` field is what every collaboration protocol
  wants as input. Designing for undo produced the shape collaboration needs.
- **Good.** `map.debug` and telemetry get an honest, semantic action log for free.
- **Bad.** Boilerplate. Every mutation is a class with `execute` and `undo`, and the
  temptation to reach into the store directly is constant. `store._add/_update/_remove` are
  marked `@internal` and the store freezes reads in development for exactly this reason.
- **Bad.** The deep-equality contract is demanding. A command that captures _what it was
  asked to do_ can undo approximately; only a command that captures _what the store actually
  did_ — the minted ids, the stamped meta — can undo exactly. Getting this wrong produces a
  bug that surfaces three actions later, which is why the round-trip test is mandatory.
- **Bad, and open.** `execute()` is synchronous while the commit pipeline is async, so
  `dispatch()` does not run the commit pipeline itself. Today a write that must be validated
  runs `await map.commit.run(ctx)` first and dispatches only if it survived. That is a real
  ergonomic wart; see ADR 0004 and the roadmap.
