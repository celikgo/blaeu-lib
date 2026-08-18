# @blaeu/plugin-edit

Vertex editing, transforms, split and merge — with topological awareness.

This is the cadastre-critical plugin. Two of its decisions are the reason it exists,
and both are about not losing a millimetre:

- **Topological editing.** With `topological: true`, dragging a corner that two
  parcels share moves it in **both**, in **one command**, so undo restores both. The
  shared corners are found through the store's topology index, which keys on a
  _quantised_ coordinate — so two parcels whose corners were digitised 0.4 mm apart
  still count as sharing one. A system that lets adjacent parcels drift 3 cm apart
  has not produced a rendering artefact; it has produced a strip of land with no
  owner.
- **No float accumulation.** Every frame of a drag recomputes the geometry from the
  shape as it was when the drag _started_, plus the total delta — never from the
  previous frame. A 200-frame drag that chained 200 incremental transforms would
  compound 200 rounding errors, and the vertex would land somewhere the surveyor did
  not drop it.

## Install

```bash
npm install @blaeu/plugin-edit
```

> Not on npm yet — see [the root README](../../README.md#packages) for how to run it from source.

`@blaeu/core` is a **peer** dependency. This package also depends on `jsts` at runtime — it is
what `split` and `merge` are built on, and the only third-party geometry library in the repo
(see `src/jsts.ts` for why not Turf).

```ts
import { createBlaeuMap } from '@blaeu/core'
import { editPlugin } from '@blaeu/plugin-edit'

const map = await createBlaeuMap({
  container: '#map',
  plugins: [editPlugin({ topological: true })],
})

map.plugin('edit').edit('parcel-42') // typed as EditApi — no cast
```

## Options

| Option              | Default | Meaning                                                                                                                                                     |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topological`       | `false` | Move a shared corner in every feature that has one there. **Cadastre wants this on.** Off by default because it is a surprise on a map of unrelated shapes. |
| `allowVertexDelete` | `true`  | Whether Alt-click / Delete removes a vertex.                                                                                                                |
| `minVertices`       | —       | Raises the floor on how few corners a ring may keep. It cannot lower the geometric minimum (3 for a polygon, 2 for a line).                                 |
| `handleSize`        | `10`    | Grab radius for handles, in screen pixels.                                                                                                                  |

## What it registers

**Tools** (activate with `map.tools.activate(id)`):

| Tool             | What it does                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edit:vertex`    | The default mode. Drag a vertex; click a midpoint to insert one; Alt-click or press Delete/Backspace to remove one; Escape rolls back the drag in flight and ends the session. Clicking a different feature starts editing that one instead. |
| `edit:transform` | Bounding-box gizmo: drag inside to move, a corner to scale, the stalk to rotate. Operates on the selection when a select plugin is installed, otherwise on the feature being edited.                                                         |
| `edit:split`     | Click to draw the cut line, double-click or Enter to cut, Escape to abandon.                                                                                                                                                                 |
| `edit:merge`     | Click the parcels to merge (seeded from the selection); click one again to take it back out; Enter or double-click to merge; Escape to abandon the picks.                                                                                    |

**Store collections and layers** — `edit:vertices`, `edit:midpoints`, `edit:guides`.
The handles are ordinary features in ordinary vector layers, styled from theme tokens
(`color.vertex`, `color.vertexActive`, `color.midpoint`, `color.guide`, `size.vertexRadius`,
`size.midpointRadius`), which means they are hit-testable, restylable by a preset, and
visible to any other plugin. They are written with `transient` commands, so they never
appear in the undo stack.

**Commands** — during a drag, `MoveVerticesCommand` / `SetGeometriesCommand` are
dispatched as _transient_ previews: redrawn, never recorded, never validated. Mid-drag
geometry is legitimately invalid, so validating each frame would be both slow and wrong.
On release the controller commits one `CommitEditCommand` through the pipeline. That
single validated write is the one undo step, and it is what lets a preset's rules veto
the finished edit. `coalesceWith` is still implemented on both geometry commands, for a
caller that dispatches them durably.

## Dependencies

All optional, and all genuinely so — the degradation test proves it:

| Plugin    | What it adds                                                                        | Without it                                        |
| --------- | ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| `snap`    | The position the tools read has already been snapped, by middleware they never see. | Editing works, unsnapped.                         |
| `select`  | The transform gizmo works on a multi-feature selection.                             | The gizmo works on the feature being edited.      |
| `history` | A coalesced drag becomes one Ctrl-Z.                                                | Commands still round-trip; nothing keeps a stack. |

## API

```ts
import type { FeatureId, LineString, LngLat, ProjectedXY } from '@blaeu/core'

interface EditApi {
  edit(id: FeatureId): void // show handles, activate edit:vertex, emit edit:start; throws if locked
  stop(): void // cancellable via before:edit:complete
  readonly editing: FeatureId | null

  split(id: FeatureId, line: LineString): Promise<void> // JSTS noding + polygonize, one undo step
  merge(ids: readonly FeatureId[]): Promise<void> // JSTS union, one undo step

  rotate(ids: readonly FeatureId[], degrees: number, pivot?: LngLat): void
  scale(ids: readonly FeatureId[], factor: number, pivot?: LngLat): void
  move(ids: readonly FeatureId[], delta: ProjectedXY): void // metres in the working CRS
}
```

`edit()` throws if the feature has `meta.locked === true` — unlock it first. While the
plugin is disabled it is a silent no-op, because a click on a read-only map is not an
application error; `disable()` also deactivates any active `edit:*` tool and ends the
session.

`split` **rejects** — rather than producing garbage — when the cut line does not fully
cross the feature, and `merge` rejects when the inputs are not contiguous (a shared
_edge_, not a corner touch). Merging two disjoint parcels into a MultiPolygon is
almost never what a surveyor meant, and silently doing it is worse than refusing.
Both are async, so nothing is ever thrown synchronously: the tools act on the settled
promise and re-emit the refusal as `map:error`, and a script must `await` the call — or
attach a `.catch` — to handle a refusal. A `try`/`catch` around the bare call never
fires, and the rejection goes unhandled.

Rotate, scale, move, split and merge all happen in the **projected working CRS**, in
metres (core invariant 3). Sphere maths is not survey maths.

**Also exported.** The command classes `GeometryEditCommand`, `MoveVerticesCommand`,
`SetGeometriesCommand` and `CommitEditCommand`, with their `EditCommandOptions`; the
handle-collection ids `VERTEX_COLLECTION`, `MIDPOINT_COLLECTION`, `GUIDE_COLLECTION` and
the `HANDLE_COLLECTIONS` set; and the `Handle` / `HandleRole` types. The collection ids are
deliberately public, because a UI plugin may legitimately read them —
`store.collection('edit:vertices')` is a supported thing to do.

The plugin also registers `en` and `tr` message bundles, so the undo-menu labels it stamps
on its commands ("Move shared corner", "Ortak köşe taşı") are localised at the point of
dispatch — by the time a history UI renders the stack the locale may have changed, but the
label the user recognises is the one from when they did the thing.

## Events

| Event                  | Payload                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `edit:start`           | `{ id, feature }`                                                                                 |
| `edit:vertex-move`     | `{ id, refs, from, to }` — `refs` has more than one entry when a shared corner moved              |
| `edit:vertex-add`      | `{ id, at, refs }`                                                                                |
| `edit:vertex-delete`   | `{ id, at, refs }`                                                                                |
| `edit:complete`        | `{ id, feature }` — `feature` is `undefined` when the session ended because the feature went away |
| `edit:split`           | `{ source, parts }`                                                                               |
| `edit:merge`           | `{ sources, feature }`                                                                            |
| `before:edit:complete` | `{ id, feature }` — **cancellable**: `preventDefault()` keeps the user in the session             |

On both events `feature` is `undefined` when the session ended because the feature went
away — split, merged or removed out from under it — so a listener that reaches straight
for `e.payload.feature.geometry` throws.
