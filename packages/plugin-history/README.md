# @blaeu/plugin-history

Undo/redo for Blaeu — including for plugins that do not exist yet.

This plugin is the proof that the command-bus design works. It knows **nothing**
about drawing, editing, parcels or vertices. It subscribes to
`commands.onDidExecute`, keeps two stacks of `Command`s, and calls `undo()` on
them.

That is the whole point. A plugin written by a stranger in three years gets Ctrl+Z
for free by dispatching a `Command` — no registration call here, no import there,
no coupling in either direction. If a mutation goes through the command bus, it is
undoable; if it does not, it is not, and that is the only rule.

## Install

```ts
import { createBlaeuMap } from '@blaeu/core'
import { historyPlugin } from '@blaeu/plugin-history'

const map = await createBlaeuMap({
  container: '#map',
  plugins: [historyPlugin({ limit: 200 })],
})

const history = map.plugin('history') // → HistoryApi, no cast

history.undo()
history.canUndo // false, if that was the last one
history.undoLabel // → 'Move vertex' — feed it straight to the menu item
```

Undo already works at this point for _every_ plugin on the map, because they all
mutate through the bus. A durable write is a `commit` — `dispatch` is for transient
scaffolding only and refuses a feature-writing command, at compile time and at
runtime both:

```ts
import { AddFeaturesCommand } from '@blaeu/core'
import type { BlaeuMap, Geometry } from '@blaeu/core'
import type { HistoryApi } from '@blaeu/plugin-history'

declare const map: BlaeuMap, history: HistoryApi, geometry: Geometry

await map.commands.commit(new AddFeaturesCommand('parcels', [{ geometry }]))
history.undo() // the parcel is gone, byte for byte as before
```

## What it registers

| Thing                | Where                                                 |
| -------------------- | ----------------------------------------------------- |
| `history` plugin API | `map.plugin('history')` → `HistoryApi`                |
| One subscription     | `commands.onDidExecute` — the recorder                |
| One DOM listener     | `keydown` on the map container, when `keyboard` is on |
| One event            | `history:changed`                                     |

No layers, no sources, no interaction middleware, no commit middleware. Removing
the plugin (`await map.remove('history')`) returns `map.debug.snapshot()` to
exactly where it was — there is a test for that.

## Dependencies

**None**, and it must stay that way. The moment history knows the name of another
plugin, it has stopped being a general undo system. `@blaeu/core` is a peer
dependency.

## Options

| Option             | Default | Meaning                                                                                                                                                                                                          |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit`            | `100`   | Maximum undo depth. The **oldest** entry is dropped when it is exceeded. Must be a finite number ≥ 1 — anything else throws at setup; fractional values are floored. To disable undo, do not install the plugin. |
| `coalesceWindowMs` | `300`   | Ceiling on how long a command may still merge into the one before it. `0` disables merging. Must be finite and ≥ 0; a negative value throws at setup.                                                            |
| `keyboard`         | `true`  | Bind Ctrl/Cmd+Z and Ctrl+Shift+Z / Ctrl+Y.                                                                                                                                                                       |
| `container`        | —       | Where to bind those keys. Defaults to the map container, recovered from the renderer.                                                                                                                            |

Both defaults are exported as `DEFAULT_LIMIT` and `DEFAULT_COALESCE_WINDOW_MS`, so
a host UI can show them without hardcoding.

### Coalescing

`coalesceWindowMs` is a ceiling for commands that cannot say what they belong to
(keystrokes). Whether two commands merge is decided by the _command_, through
`Command.coalesceWith(previous)`. History asks when the previous command arrived
inside the window — or, whatever the clock says, when both commands declare the
same `Command.gesture`: a surveyor who drags a shared corner, pauses to read the
coordinate, then nudges it home made one gesture and owes exactly one Ctrl-Z.
`coalesceWindowMs: 0` disables merging entirely, gesture or not.

The window is what keeps a 200-pixel vertex drag from producing 200 undo entries,
and what makes typing `Kadıköy` into an attribute field one Ctrl+Z rather than
seven.

### Keyboard

Bound on the **map container, never on `window`** — two maps on one page with a
window-level binding both undo on one Ctrl+Z, and the user loses an edit on a map
they were not even looking at. Cmd on macOS, Ctrl elsewhere; Ctrl+Y is redo only
off macOS. Nothing fires while focus is in an `input`, `textarea`, `select` or a
`contenteditable` — the text editor's own undo must win there.

`PluginContext` does not expose the map container, so the plugin recovers it from
the renderer (`getContainer()` on MapLibre, `container` on the test
`FakeRenderer`). If your renderer offers neither, pass `container` explicitly; the
plugin will not silently fall back to `window`.

## API

```ts
interface HistoryApi {
  undo(): boolean
  redo(): boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly undoLabel: string | undefined
  readonly redoLabel: string | undefined
  clear(): void
  readonly depth: number
  onChange(handler: () => void): Disposable
}
```

`undo()` and `redo()` return `false` when there was nothing to do, and also when the
replay itself failed — a menu item that greys itself out on `canUndo` is not enough,
because a command whose `undo()` throws is a bug that the caller should see. `clear()`
forgets both stacks, which is what you want after a save or after loading a new
document: undoing past the point where the file was written is not history, it is a
data loss report.

## Events

| Event             | Payload                                                 |
| ----------------- | ------------------------------------------------------- |
| `history:changed` | `{ canUndo: boolean; canRedo: boolean; depth: number }` |

Emitted whenever either stack changes — a record, an undo, a redo, a `clear()`.
`HistoryApi.onChange(handler)` is the same signal without the payload, and returns
a `Disposable`.

```ts
map.events.on('history:changed', (e) => {
  undoButton.disabled = !e.payload.canUndo
  undoButton.title = history.undoLabel ?? 'Undo'
})
```

## Behaviour worth knowing

- **Transient commands are never recorded.** A hover highlight or a rubber-band
  preview should not be something the user has to press Ctrl+Z past.
- **A transaction is one entry.** A transaction with two or more recordable
  commands is recorded as one composite carrying the transaction's label — undoing
  a parcel split restores the original parcel and removes both halves, in one step.
  A transaction with a single recordable command is recorded as that command,
  keeping its own label, so the menu says "Move vertex" and not "Transaction". A
  transaction whose children were all transient records nothing.
- **A new action clears the redo stack** — classic linear history, which is what
  every editor the user has already used does.
- **An undo cannot record itself.** Commands dispatched _during_ a replay (by a
  listener keeping derived state in step, say) are not pushed onto the stack.
- **A command whose `undo()` throws does not kill the map.** The stacks are left
  untouched, `undo()` returns `false`, and a `map:error` is emitted with source
  `history:undo`. That is a bug in the command — `undo(execute(s))` must restore
  `s` to deep equality — and it is reported as one.
- **Disabling parks the recorder, it does not wipe it.** `map.plugins.disable('history')`
  stops new commands being recorded; the stacks survive, so `map.plugins.enable('history')`
  resumes with the user's earlier edits still undoable. Removing the plugin is what
  forgets them.
