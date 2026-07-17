---
name: blaeu-plugin-authoring
description: How to write a BlaeuMap plugin — the lifecycle contract, typed registry augmentation so map.plugin('id') needs no cast, extension points (snap providers, layer types, commands, middleware), and the dependency rules. Use when creating a new packages/plugin-* or changing an existing plugin's shape.
---

# Authoring a BlaeuMap plugin

A plugin is a function returning an object. That's the whole thing. It gets a
`PluginContext`, registers what it wants, and returns its public API.

```ts
export interface DrawApi {
  start(mode: DrawMode): void
  cancel(): void
  readonly active: DrawMode | null
}

export function drawPlugin(opts: DrawOptions = {}): BlaeuPlugin<DrawApi> {
  return {
    id: 'draw',
    version: '1.0.0',
    dependencies: [
      { id: 'snap', optional: true }, // enhances, does not require
      { id: 'history', range: '^1.0.0' }, // hard requirement, version-checked
    ],

    setup(ctx): DrawApi {
      const tools = new Map<DrawMode, Tool>()
      // ...
      ctx.disposables.add(ctx.tools.register('draw:polygon', polygonTool(ctx, opts)))
      return {
        start,
        cancel,
        get active() {
          return current
        },
      }
    },

    enable(ctx) {
      /* re-arm listeners; called on map.enable('draw') */
    },
    disable(ctx) {
      /* go dormant but stay registered — keep state */
    },
    destroy(ctx) {
      /* ctx.disposables auto-disposes; only exotic cleanup here */
    },
  }
}
```

`setup` runs once, `enable`/`disable` can run many times, `destroy` runs once.
Anything you register in `setup` must go through `ctx.disposables` — see
`blaeu-core-invariants` rule 5, and the teardown test that enforces it.

## Make it typed. This is the DX differentiator.

Augment the registry from your plugin's entry point, and `map.plugin('draw')`
resolves to `DrawApi` with no cast, no generic, no import gymnastics:

```ts
declare module '@blaeu/core' {
  interface BlaeuPluginRegistry {
    draw: DrawApi
  }
  interface BlaeuEventMap {
    'draw:start': { mode: DrawMode }
    'draw:complete': { feature: BlaeuFeature }
    // `before:` prefix is what makes an event cancellable — the type system
    // only lets emitCancellable() accept keys matching `before:${string}`.
    'before:draw:complete': { feature: BlaeuFeature }
  }
}
```

Skipping this is the single most common way a plugin ends up feeling
second-class. Do it even for tiny plugins.

## Pick the right extension point

Most plugins do _not_ need a new one. Reach for these first:

| You want to…                                        | Register a…            | And you get                                                     |
| --------------------------------------------------- | ---------------------- | --------------------------------------------------------------- |
| Modify the pointer position before any tool sees it | interaction middleware | snapping, grid lock, ortho constraint — for free, in every tool |
| Veto or rewrite a mutation before it lands          | commit middleware      | validation, attribute defaults, audit stamps                    |
| Add a new kind of snap target                       | `SnapProvider`         | your targets show up in every tool that snaps                   |
| Add a new kind of layer                             | `LayerTypeDef`         | `map.layers.add({ type: 'your-type' })`                         |
| Make something undoable                             | `Command`              | cross-plugin undo/redo, transactions, coalescing                |
| React to something                                  | `ctx.events.on(...)`   | —                                                               |

The rule of thumb: **if your plugin has to know about another plugin by name, you
picked the wrong extension point.** The draw plugin does not import the snap
plugin. It doesn't know snapping exists. Snapping is middleware that rewrote
`ctx.lngLat` before the draw tool ever read it. That indirection is the entire
architecture — preserve it.

## Optional dependencies must actually degrade

`{ id: 'snap', optional: true }` means the plugin **works without it**, not that
it crashes politely. Guard with the capability check, never with a bare
`map.plugin()` that throws:

```ts
const snap = ctx.tryPlugin('snap') // → SnapApi | undefined
snap?.addProvider(myParcelCornerProvider)
```

Then write the degradation test (`blaeu-testing`, test 1). An "optional"
dependency with no test proving the map works without it is a required dependency
with a bug.

## Commands, not setters

Anything that changes a feature is a `Command`. Coalescing is what keeps a drag
from producing 200 undo entries:

```ts
class MoveVertexCommand implements Command {
  readonly type = 'draw:move-vertex'
  readonly label = 'Move vertex' // shown in the undo menu / history UI

  coalesceWith(prev: Command): Command | null {
    // Merge only if it's the *same vertex* in the same gesture, so undo steps
    // back one whole drag — not one mouse-move.
    if (prev instanceof MoveVertexCommand && prev.targets(this)) {
      return new MoveVertexCommand(this.id, this.ring, this.idx, this.to, prev.from)
    }
    return null
  }
  // execute / undo — must round-trip to deep equality
}
```

## Package checklist

- `package.json`: `@blaeu/core` is a **peerDependency**, never a dependency —
  two copies of the core means two event buses and two stores, and the symptom is
  "my listener never fires," which is a bad afternoon.
- Side-effect free (`"sideEffects": false`) so it tree-shakes.
- Named export `xPlugin()`, plus the `Api` and `Options` types.
- README with: what it registers, what it depends on, what events it emits.
- The three tests from `blaeu-testing`.
