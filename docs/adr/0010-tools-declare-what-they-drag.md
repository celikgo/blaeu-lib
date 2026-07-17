# ADR 0010 — A tool declares what it is dragging; middleware must not fight it

Status: accepted
Amends [ADR 0003](./0003-snapping-as-interaction-middleware.md).

## Context

[ADR 0003](./0003-snapping-as-interaction-middleware.md) claims that snapping reaches every
tool **purely** through interaction middleware that rewrites `ctx.lngLat`, and that this is
why the measure plugin snaps to parcel corners without containing a line of snapping code or
ever importing `@blaeu/plugin-snap`.

That claim is true for tools that _place_ new geometry. It was false — and destructively so —
for tools that _drag existing_ geometry, which is most of `plugin-edit`.

The failure is worth stating precisely, because nothing about it looks like a bug:

1. The user grabs the south-east corner of a parcel and drags it 8 m.
2. On the first `pointermove`, the snap engine scans for candidates near the pointer. It finds
   the parcel's own corner — still sitting where the drag began, a few pixels away — and the
   **vertex handle drawn on top of it**, which is a real feature in a real store collection.
3. It snaps the pointer back onto them.
4. The tool computes the vertex's new position from the (snapped) pointer, concludes it has not
   moved, and writes it back where it was.
5. Repeat, forever.

Every drag shorter than the snap tolerance became a **silent no-op**. A scale gesture grabbed
its own corner, so the ratio of pointer distances stayed 1 and the parcel refused to resize.
Nothing threw. Nothing logged. The store was never corrupted — it was simply never changed. The
parcel just would not edit, and the only way to make it edit was to uninstall the _optional_
plugin.

Measured, with the same gesture, in `preset-cadastre/src/drag-with-snap.test.ts`:

```
edit alone   ->  0.001 m from the drop point
edit + snap  -> 10.977 m from the drop point   (i.e. exactly back where it started)
```

`cadastrePreset()` ships both plugins. The flagship preset shipped broken vertex editing.

`plugin-draw` did not suffer this, because it works around it: its session duck-types
`ctx.tryPlugin('snap')` and calls `SnapApi.setInProgress()` / `SnapApi.exclude()` so the rubber
band does not snap to itself. That is a second, out-of-band channel between two plugins — and
`plugin-edit` simply never grew one.

## Decision

**Two facts move into the kernel, and neither plugin learns about the other.**

```ts
// A tool states what it has hold of, for the duration of one gesture.
interface ToolManager {
  setDragging(ids: readonly FeatureId[]): void
  readonly dragging: readonly FeatureId[]
}

// Middleware reads it off the interaction context.
interface InteractionContext {
  readonly dragging: readonly FeatureId[]
}

// A feature states that it is a picture of the data, not data.
interface FeatureMeta {
  readonly snappable?: boolean // default true
}
```

- `plugin-edit`'s vertex and transform tools call `tools.setDragging([...])` on pointer-down and
  `setDragging([])` on pointer-up or Escape.
- `plugin-edit`'s handles and its transform box are written with `meta.snappable === false`.
- `plugin-snap`'s engine unions `ctx.dragging` into its exclusion set, and skips any feature
  with `snappable === false`.

Handles are marked on the _feature_, not listed by id, because handles are rebuilt on every
frame of a drag — an id list would go stale mid-gesture. And they are marked in `meta` rather
than filtered by collection name in the snap plugin, because a snap plugin holding a hardcoded
list of the collection names the edit plugin happens to use is precisely the coupling this
library exists to avoid.

## Consequences

- **The bug is fixed, and snapping still works.** The drag now lands 0.001 m from the drop
  point, and a corner aimed _near_ a neighbouring parcel's corner still snaps _exactly_ onto it
  (< 2 mm) — which is the operation a surveyor actually cares about, and the one that must
  survive any fix. The neighbour is not moved. All three are asserted.
- **`plugin-edit` still does not import `plugin-snap`, and `plugin-snap` still does not import
  `plugin-edit`.** `scripts/check-boundaries.mjs` enforces it and passes. The two plugins meet
  on kernel types neither of them owns, which is the same shape as the rest of the library.
- **ADR 0003's claim is amended, not withdrawn.** Snapping still reaches every tool through
  middleware, and a tool still contains no snapping code. But "purely" was too strong: a tool
  that drags geometry must tell the pipeline _what is in play_, or any middleware that
  reasons about nearby features will fight the gesture. That is not a wart in the snapping
  design — it is a fact about dragging, and every CAD system encodes it somewhere. The
  question is only whether it is encoded as a plugin-to-plugin phone call (which is what
  `plugin-draw` does, and what this ADR now supersedes for `plugin-edit`) or as a fact on a
  kernel type that anyone may read. It is the second.
- **`snappable` is deliberately broader than snapping.** Anything that treats features as
  _content_ — measurement, selection, a nearest-feature query, an export — wants to skip UI
  scaffolding, and the alternative is every such plugin growing its own list of other
  plugins' collection names. The name is the first consumer, not the limit of the concept.
- **`plugin-draw` still uses its `tryPlugin('snap')` channel.** It works, and its
  `setInProgress()` carries information (`the ring I am still closing`) that `dragging` does
  not yet express. Folding it into this mechanism is a follow-up, not a prerequisite.
