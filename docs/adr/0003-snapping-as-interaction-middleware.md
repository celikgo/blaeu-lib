# ADR 0003 — Snapping is interaction middleware, not a service tools call

Status: accepted

## Context

Snapping is the feature that decides whether a drawing tool is usable for survey work. It is
also the feature that, in every mapping library we looked at, is implemented as a method the
drawing tool calls — `snapTo(lngLat)`, or a `snap` option on the draw tool's constructor.

That arrangement has a specific failure mode, and it is not subtle once you have seen it:
**every tool must remember to snap.** The draw tool does. The vertex-edit tool does. The
measure tool was added six months later and does not, and nobody notices until a surveyor
measures a boundary and gets a number 4 cm off, because the measurement endpoint landed near
the corner rather than on it. Then the split tool is added, and it happens again. The library
has no way to make a tool snap; it can only ask.

And there is a second, worse version: a tool written by _someone else_ — a plugin from a
marketplace, an internal tool at a municipality — cannot snap at all unless it imports our
snap plugin and calls it correctly. We would have made snapping a privilege of the tools we
shipped.

## Decision

**Snapping is interaction middleware. It rewrites the pointer position before any tool sees
the event.**

The snap plugin registers exactly one middleware, at priority 100 — the highest in the
chain. On every pointer event it queries its `SnapProvider`s, ranks the candidates, and sets:

```ts
ctx.snap = { candidate, alternatives }
ctx.lngLat = candidate.point // ← the load-bearing line
next()
```

`InteractionContext.lngLat` is mutable for exactly this purpose. `ctx.rawLngLat` keeps the
original (providers query against it, so the snap is not sticky), and `ctx.xy` is a getter
that re-projects `lngLat` on every read, so a cached projected coordinate cannot drift out
of sync with a snapped geographic one.

By the time `FlexiMap` hands the context to the active tool, the position has already been
snapped, grid-locked, and constrained by whatever the preset installed. **The draw plugin
has never heard of the snap plugin and does not import it.** It reads `ctx.lngLat`, like
every other tool.

Snapping is open-ended in the same way: `SnapProvider` is an interface anyone can implement.
Core snapping covers vertex, edge, midpoint, intersection, extension, perpendicular and grid;
a cadastre plugin adds `parcel-corner`, a utilities plugin adds `pipe-junction`, and
`preset-game` adds `hex-centre` in one file. Register it, and every tool in the product snaps
to it.

## Alternatives rejected

**A `SnapService` that tools call** (`const p = snap.resolve(lngLat)`). The obvious design,
and the one we rejected: it makes correct snapping opt-in per tool, so the guarantee is only
as strong as the least careful tool author. It also cannot express Alt-to-suppress, cursor
feedback or snap-indicator rendering once — each tool would reimplement all three, slightly
differently.

**A snap option on each tool** (`drawPlugin({ snap: true })`). Same failure, plus it makes
the draw plugin depend on the snap plugin's option shape, which is precisely the
plugin→plugin coupling the boundary rules forbid.

**Snapping inside the renderer**, i.e. the renderer emits already-snapped pointer events.
Tempting, because the renderer already owns `project`/`unproject`. Rejected because the
renderer would then need to know about the store, the spatial index, the working CRS and the
provider registry — which is to say it would stop being a renderer. It would also make
snapping untestable without a renderer, and impossible to reorder relative to other
constraints.

**Post-processing in the tool** ("let the tool snap the point it just received"). Identical
to the service option in every practical respect, and it additionally denies the UI a
position to render an indicator at until after the tool has run.

## Consequences

- **Good.** Every tool snaps, including ones written by strangers next year, including ones
  written before the snap plugin existed. This is the entire point.
- **Good.** Cross-cutting behaviour is implemented once. Alt-suppresses-snap (the universal
  CAD convention) is four lines in the middleware and applies everywhere. So does the
  indicator, and so does the pointer readout showing the _post_-snap coordinate — which is
  the one that will actually be stored.
- **Good.** Priority ordering composes. A "constrain to 45° increments" middleware registered
  _below_ snapping deliberately overrides it; registered above, it would move the pointer off
  the corner the indicator is promising, which the user reads as the software lying. The
  ordering is a decision the preset author gets to make, not one baked into a tool.
- **Bad.** The indirection surprises newcomers. "Where does the draw tool snap?" has no
  answer, because it does not; the honest answer is `map.debug.interactionMiddleware()`. We
  pay this in documentation.
- **Bad.** Middleware runs on _every_ pointer event, so a slow provider is a slow map. The
  contract is explicit — providers query the spatial index via the precomputed
  `SnapQueryContext.bbox` and never scan — but nothing enforces it. A pathological provider
  can make the cursor stutter, and the pipeline being synchronous (ADR 0004) means it cannot
  be pushed off-thread.
- **Bad.** Some gesture state genuinely has to flow from the tool _to_ the snap engine: the
  ring's committed vertices (so you can close a polygon on its own first corner) and the
  feature being dragged (so it cannot snap to itself). The draw plugin passes both through a
  duck-typed, optional handle rather than an import — which preserves the boundary but is
  the one place the abstraction leaks.
