# ADR 0011 — A transient edit preview preserves ring order; only durable writes rewind

Status: accepted

## Context

Two rules the store enforces on every write collided, and the collision silently rewrote
land.

**Rule one — rings are wound RFC 7946 on the way in.** `normaliseRing` (in
`packages/core/src/utils/geometry.ts`) reverses a ring whose signed area has the wrong sign,
so an exterior ring is always counter-clockwise and a hole always clockwise. This is
load-bearing, not cosmetic: a wrongly-wound hole becomes a second exterior ring and the
parcel's area is then the _sum_ of the rings rather than the difference — a number that goes
on a deed. `FeatureStore._update` applies it to every edit, exactly as `_add` applies it to
every ingest.

**Rule two — an interactive edit addresses corners by position.** The vertex tool captures a
set of `VertexRef`s at pointer-down — `{ feature, part, ring, index }` — and replays them on
every `pointermove` (`plugin-edit/src/tools/vertex.ts`). Each frame dispatches a transient
`MoveVerticesCommand`, whose `rewrite` does `positions[ref.index] = to` against the geometry
currently in the store.

Now drag a triangle's apex straight down, across its base and out the far side:

1. The apex starts above the base; the ring `[BL, BR, apex]` is counter-clockwise. `ref.index`
   for the apex is `2`.
2. Somewhere mid-drag the apex crosses the base. The triangle is now a perfectly valid triangle
   wound the _other_ way (clockwise).
3. `_update` normalises the preview and, seeing a clockwise exterior, **reverses the ring**.
   The apex is now at index `0`; a _base_ corner is at index `2`.
4. The next `pointermove` writes `positions[2] = to`. It moves a base corner to the cursor.
5. For the rest of the gesture the drag rewrites the wrong corners. No error, no log. On
   release, a parcel with two corners in the wrong place is committed.

Measured in `plugin-edit/src/edit.test.ts` ("vertex drag across the polygon"), against the
pre-fix code: an untouched base corner ends up **33 m** from where it started.

The preview/commit split ([ADR 0009](./0009-commit-commands.md)) did not help. It changed
_which_ writes are validated and recorded in history; it did not change the fact that a
transient preview still goes through `_update` and is still normalised. The reversal happens
on the preview.

## Decision

**A transient preview write preserves the ring's coordinate order. Ingest and the durable
commit still rewind.**

`_update` grows an option:

```ts
_update(
  features: readonly BlaeuFeature[],
  options?: { readonly rewindRings?: boolean }, // default true
): readonly BlaeuFeature[]
```

which threads to `normaliseGeometry(…, rewind)` and on to `normaliseRing`, where `rewind ===
false` skips the `open.reverse()` step and nothing else — the ring is still quantised to the
CRS grid, still de-duplicated, still closed, and still rejected if it collapses to fewer than
three corners or to zero area.

`GeometryEditCommand.execute` passes `{ rewindRings: !this.transient }`. So:

- every **preview** frame (`transient`) leaves the ring order exactly as the edit produced it,
  and the positional refs captured at pointer-down keep addressing the same corners for the
  whole gesture — even across the frame where the winding flips;
- the **durable commit** (`CommitEditCommand`, never transient) and every **ingest** (`_add`,
  `materialise`) rewind as before.

`rewindRings` defaults to `true`, so every other caller — the built-in `UpdateFeaturesCommand`,
undo/redo, a programmatic edit — is unchanged.

## Consequences

- **The reported critical is fixed.** Dragging a vertex clear across the polygon now tracks the
  grabbed corner the whole way and leaves the others exactly where they were; the test asserts
  all three, plus that the committed parcel is still wound RFC 7946.
- **No stored parcel is ever wound the wrong way.** The winding invariant is unchanged for
  everything that _survives_ a gesture: the durable commit rewinds, so a parcel the user
  inverts mid-drag lands committed as a correctly-wound ring. The only geometry that is ever
  held un-rewound is a per-frame preview, which is overwritten on the next frame and replaced
  by the rewound commit on release. A reversed ring is the _same polygon_ — same corners, same
  area, same rendering — so nothing downstream that reads a preview (the renderer, a hit test,
  the topology index, which all key on coordinates, not order) sees anything different.
- **It also fixes insert-then-drag.** Grabbing a midpoint inserts a vertex and immediately drags
  it, one gesture. Because nothing reorders the ring until the post-gesture commit, the refs the
  insert handed back stay valid through the drag — a case a "recompute from the pre-edit
  geometry" fix would have had to special-case, because the pre-edit ring has one fewer vertex.
- **This is why the fix lives at the write, not in the tool.** Making the tool re-resolve its
  refs after each frame, or match corners by coordinate, would fight coincident vertices and
  duplicate what `normaliseRing` already knows. The honest statement is narrower: _a preview is
  not an ingest, and only an ingest owes RFC 7946 winding immediately._ Everything the store
  keeps is still wound; a scratch frame under the user's finger need not be.

## Follow-ups — a positional ref must not outlive the commit's rewind

Splitting the preview order (un-rewound) from the committed order (rewound) means the ring
_does_ still get reordered once, at the commit. Anything holding a **positional** vertex
reference _across_ that boundary is then stale. A `commit`-time rewind was always possible;
what changed is that the gesture now completes cleanly first (rather than corrupting the
geometry as it went), so a stale ref lands in a valid, actionable state instead of amid
garbage. Two such refs existed, and both are re-anchored to _coordinates_ rather than indices:

- **The Delete key** (`plugin-edit/src/tools/vertex.ts`) cached the working vertex as a
  `VertexRef` and re-picked its handle by ring index. After a winding-flipping drag committed,
  that index named a different corner, so Delete removed one the user never touched. It now
  tracks the vertex's **coordinate** and re-picks the handle sitting on it — order-proof.
- **A re-entrant gesture during an async commit.** `commit()` is asynchronous (a validation
  middleware may await a server), so its rewind can land _after_ the user has grabbed a corner
  again — reversing the ring under the new gesture's live positional refs. The controller now
  **converges the ring to committed winding synchronously on release**
  (`EditController.#rewindToCommittedWinding`), before the async commit and before any next
  gesture, so the commit's own rewind is a no-op and can reorder nothing. A no-op for the
  common drag that never flipped a winding.

Both are the same lesson the main decision teaches, one layer out: a ring index is only stable
_within_ a gesture that does not rewind; the moment a rewind can intervene, address the corner
by where it is, not by where it sits in the array.
