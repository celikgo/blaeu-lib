---
name: blaeu-plugin-authoring
description: How to write a Blaeu plugin — the lifecycle contract, capability tokens, typed registry augmentation so map.plugin('id') needs no cast, extension points (snap providers, layer types, commands, interaction and commit middleware), and the dependency rules. Use when creating a new packages/plugin-* or changing an existing plugin's shape.
---

# Authoring a Blaeu plugin

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
    // Capability tokens, beyond the id. A dependent can then declare
    // `{ id: 'snap-engine' }` and be satisfied by *any* plugin providing it — which is
    // what lets a user swap our snapping for theirs without every dependent knowing.
    provides: ['draw-tools'],
    dependencies: [
      { id: 'snap', optional: true }, // enhances, does not require
      { id: 'history', range: '^1.0.0' }, // a *hard* dependency, version-checked
      // (the real draw plugin marks history optional too — drawing without an undo
      // stack is a supported configuration. A ranged hard dep looks like this.)
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
      /* re-arm listeners; called on map.plugins.enable('draw') */
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

| You want to…                                        | Register a…                                                  | And you get                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Modify the pointer position before any tool sees it | interaction middleware                                       | snapping, grid lock, ortho constraint — for free, in every tool                                  |
| Veto or rewrite a mutation before it lands          | commit middleware                                            | validation, attribute defaults, audit stamps                                                     |
| Add a new kind of snap target                       | `SnapProvider`                                               | your targets show up in every tool that snaps                                                    |
| Add a new kind of layer                             | `LayerTypeDef`                                               | `map.layers.add({ type: 'your-type' })`                                                          |
| Make something undoable                             | `Command`                                                    | cross-plugin undo/redo, transactions, coalescing                                                 |
| React to something                                  | `ctx.events.on(...)`                                         | —                                                                                                |
| Drag features without them snapping to themselves   | `ctx.tools.setDragging(ids)` in the tool, `[]` on pointer-up | snapping, grid lock and any future constraint middleware all skip what is in play — see ADR 0010 |

The last row is not optional for a tool that moves geometry. A dragged vertex is a
real feature in the store, sitting exactly under the cursor, so it is its own best
snap target — and offering it its own current position pins it there. Every drag
shorter than the snap tolerance silently becomes a no-op, which gets reported as
"snapping is broken". The tool is the only thing that knows what is in play, so it
states the fact on a kernel type and the edit plugin still never hears of the snap
plugin.

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
class NudgeCommand implements Command {
  readonly type = 'demo:nudge'
  readonly label = 'Nudge' // shown in the undo menu / history UI

  coalesceWith(prev: Command): Command | null {
    // Merge only if it's the *same target* in the same gesture, so undo steps
    // back one whole drag — not one mouse-move.
    if (prev instanceof NudgeCommand && prev.targets(this)) {
      return new NudgeCommand(this.id, this.to, prev.from)
    }
    return null
  }
  // execute / undo — must round-trip to deep equality
}
```

Deliberately a made-up command, so it cannot be mistaken for the real one. The
shipped example is `MoveVerticesCommand` in
`packages/plugin-edit/src/commands.ts`: `type = 'edit:move-vertices'`,
`constructor(refs: readonly VertexRef[], from: LngLat, to: LngLat, options?: EditCommandOptions)`,
extending `GeometryEditCommand` rather than implementing `Command` directly. Its
`coalesceWith` merges only within the same `options.gesture` — read that one
before writing your own.

## Package checklist

- `package.json`: `@blaeu/core` is a **peerDependency**, never a dependency —
  two copies of the core means two event buses and two stores, and the symptom is
  "my listener never fires," which is a bad afternoon.
- Side-effect free (`"sideEffects": false`) so it tree-shakes.
- Named export `xPlugin()`, plus the `Api` and `Options` types.
- README with: what it registers, what it depends on, what events it emits.
- The three tests from `blaeu-testing`.
