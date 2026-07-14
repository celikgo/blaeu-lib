# @fleximap/plugin-history

Undo/redo for FlexiMap — including for plugins that do not exist yet.

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
import { createFlexiMap } from '@fleximap/core'
import { historyPlugin } from '@fleximap/plugin-history'

const map = await createFlexiMap({
  container: '#map',
  plugins: [historyPlugin({ limit: 200 })],
})

const history = map.plugin('history') // → HistoryApi, no cast

history.undo()
history.canUndo // false, if that was the last one
history.undoLabel // → 'Move vertex' — feed it straight to the menu item
```

Undo already works at this point for _every_ plugin on the map, because they all
mutate through the bus:

```ts
map.commands.dispatch(new AddFeaturesCommand('parcels', [{ geometry }]))
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
plugin, it has stopped being a general undo system. `@fleximap/core` is a peer
dependency.

## Options

| Option             | Default | Meaning                                                                                     |
| ------------------ | ------- | ------------------------------------------------------------------------------------------- |
| `limit`            | `100`   | Maximum undo depth. The **oldest** entry is dropped when it is exceeded.                    |
| `coalesceWindowMs` | `300`   | Ceiling on how long a command may still merge into the one before it. `0` disables merging. |
| `keyboard`         | `true`  | Bind Ctrl/Cmd+Z and Ctrl+Shift+Z / Ctrl+Y.                                                  |
| `container`        | —       | Where to bind those keys. Defaults to the map container, recovered from the renderer.       |

### Coalescing

`coalesceWindowMs` is a ceiling, not a policy. Whether two commands merge is
decided by the _command_, through `Command.coalesceWith(previous)`; history only
refuses to ask once the window has passed. This is what keeps a 200-pixel vertex
drag from producing 200 undo entries, and what makes typing `Kadıköy` into an
attribute field one Ctrl+Z rather than seven.

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
- **A transaction is one entry**, labelled by the transaction: undoing a parcel
  split restores the original parcel and removes both halves, in one step.
- **A new action clears the redo stack** — classic linear history, which is what
  every editor the user has already used does.
- **An undo cannot record itself.** Commands dispatched _during_ a replay (by a
  listener keeping derived state in step, say) are not pushed onto the stack.
- **A command whose `undo()` throws does not kill the map.** The stacks are left
  untouched, `undo()` returns `false`, and a `map:error` is emitted with source
  `history:undo`. That is a bug in the command — `undo(execute(s))` must restore
  `s` to deep equality — and it is reported as one.
