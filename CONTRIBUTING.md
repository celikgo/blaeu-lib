# Contributing

Thank you for reading this before opening a PR. The rules below are short, and every one of
them is load-bearing — each exists because breaking it is how a library stops being
extensible.

## Getting set up

```bash
npm install          # at the ROOT. Workspaces link on install.
npm run verify       # boundaries → typecheck → lint → test. This is what CI runs.
```

Individually:

```bash
npm run lint:boundaries   # package-dependency rules (below)
npm run typecheck         # tsc --build, project references, incremental
npm run lint              # eslint
npm run format            # prettier --write
npm test                  # vitest, all packages, headless
```

Tests and typecheck resolve `@blaeu/*` to **source**, not to `dist` (see the `development`
condition in each package's `exports`, and the aliases in `vitest.config.ts`). So there is no
build step in the inner loop, and a type error in the core surfaces in a plugin's test run
immediately.

## The boundary rules

```
packages/
  core/         @blaeu/core       ← depends on NOTHING in this repo
  plugin-*/     @blaeu/plugin-*   ← peer-depends on core only
  preset-*/     @blaeu/preset-*   ← depends on core + plugins
```

**The arrows only ever point left.** `npm run lint:boundaries` fails the build on:

- a `core → plugin` or `core → preset` import,
- a `plugin → plugin` import,
- a plugin listing `@blaeu/core` as a `dependency` instead of a `peerDependency`.

The first is core invariant 1: if the core needs to know something a plugin knows, the plugin
**registers** it and the core calls it through an interface the core owns. Wanting to import
a plugin into the core always means the same thing — _the core is missing an extension
point._ Add the extension point.

The second is the same rule one tier down. The draw plugin does not import the snap plugin; a
plugin that needs another plugin's API asks for it by id (`ctx.tryPlugin('snap')`) and
degrades if it is absent. If your plugin _cannot_ degrade, declare a hard dependency
(`{ id: 'snap' }`, no `optional`) — but think first about whether you have picked the wrong
extension point.

The third looks pedantic and is not. Two copies of `@blaeu/core` in a user's
`node_modules` means **two event buses, two command buses, two stores**. Nothing throws. The
plugin silently never receives an event, and someone loses a day to it. If you ever triage an
issue that says "my listener never fires", check for a duplicate core before anything else.

## The three tests every plugin owes

Non-negotiable. A plugin without them is not reviewable, because the three properties they
assert are exactly the three that cannot be established by reading the code.

Use the headless harness. It is a real kernel, a real store, real plugins, real pipelines; a
fake renderer and a stub container.

```ts
import { createTestMap } from '@blaeu/core/testing'
```

### 1. Degradation — an optional dependency really is optional

`{ id: 'snap', optional: true }` means the plugin **works without it**, not that it crashes
politely. An "optional" dependency with no test proving the map works without it is a required
dependency with a bug.

```ts
it('draws without the snap plugin present', async () => {
  const map = await createTestMap({ plugins: [drawPlugin({ collection: 'parcels' })] }) // no snap
  map.tools.activate('draw:polygon')
  map.test.click([32.85, 39.93])
  map.test.click([32.851, 39.93])
  map.test.click([32.851, 39.931])
  map.plugin('draw').finish()
  expect(map.store.collection('parcels').size).toBe(1)
})
```

Guard with `ctx.tryPlugin('snap')?.…`, never with a bare `ctx.plugin('snap')`, which throws.

### 2. Teardown — removing the plugin leaks nothing

A plugin that registers a listener without putting it in `ctx.disposables` leaks it forever,
and worse, a re-registered plugin then runs its handler twice.

```ts
it('leaks nothing on removal', async () => {
  const map = await createTestMap({ plugins: [drawPlugin()] })
  const before = map.debug.snapshot()
  await map.remove('draw')
  const after = map.debug.snapshot()

  expect(after.listeners).toBe(before.listeners) // no orphaned subscriptions
  expect(after.middleware).toBe(before.middleware)
  expect(after.layers).toBe(before.layers)
  expect(after.plugins).toBe(before.plugins - 1)
})
```

`map.debug.snapshot()` returns `{ listeners, middleware, layers, plugins, features }`. It
exists for this test.

### 3. Undo round-trip — the one that catches real bugs

```ts
it('round-trips every command', async () => {
  const map = await createTestMap({
    plugins: [editPlugin(), historyPlugin()],
    features: { parcels: sharedEdgeParcels() },
  })
  const before = map.store.snapshot()

  map.plugin('edit').move(['parcel-left'], [1.5, 0]) // metres in the working CRS
  expect(map.store.snapshot()).not.toEqual(before)

  map.plugin('history').undo()
  expect(map.store.snapshot()).toEqual(before) // deep equality, no tolerance
})
```

If `undo` cannot restore **deep equality**, the command captured too little state. Do not
loosen the assertion — fix the command. A command that captures _what it was asked to do_ can
undo approximately; only one that captures _what the store actually did_ (the minted ids, the
stamped meta) can undo exactly.

### Assertions on coordinates

Use a **metric** tolerance, never a decimal-places one:

```ts
import { expectWithinMetres } from '@blaeu/core/testing'
expectWithinMetres(actual, expected, 0.001) // 1 mm
```

`toBeCloseTo(lng, 6)` means a different distance at 39°N than at 60°N, which makes it a
latitude-dependent flake generator.

Prefer fixtures that are _nasty_, because nasty is what production sends: `sharedEdgeParcels()`
(two parcels sharing a boundary exactly), `sliverParcels()` (0.4 mm apart — snapping and the
topology index must treat these as one corner), `selfIntersectingRing()`,
`duplicateVertexRing()`.

Do not assert on MapLibre's internal source or layer JSON. That is testing MapLibre, and it
breaks on their minor releases. The renderer contract is the boundary: assert that we call it
correctly (spy on `FakeRenderer`), not what MapLibre does afterwards.

## When a change needs an ADR

**Any change to a contract needs an ADR in `docs/adr/`, in the same PR.** Concretely:

- anything in `packages/core/src/types/` — every plugin in every downstream product
  implements against those interfaces,
- a new extension point, or a change to how an existing one is invoked,
- a change to the merge semantics of `composePresets`,
- a change to the `Command` contract, the pipeline contracts, or the `Renderer` interface,
- swapping a load-bearing dependency (a geometry engine, the renderer).

An ADR is four sections, and the third is the one that makes it worth writing:

```markdown
## Context — what forced a decision. The constraint, not the solution.

## Decision — what we chose, stated flatly, with the code that expresses it.

## Alternatives rejected — what we turned down, and WHY.

## Consequences — good and bad. Name the bad ones; every design has them.
```

**An ADR without rejected alternatives is just a description.** The next person's real
question is never "what did you do", it is "did you think about X" — and the only way to
answer that a year later is to have written down that you did, and what was wrong with it.

Adding a file needs no ADR. Adding an **entry point** to a package's `exports` does: it is a
public API surface with a versioning consequence, forever.

## House style

TypeScript strict, with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
`verbatimModuleSyntax`. ESM, `.js` extensions on relative imports, `import type` for types.
Prettier: no semicolons, single quotes, 100 columns, trailing commas. Private fields use `#`.

**Comments explain WHY, never WHAT.** The code already says what it does. A comment earns its
place by recording the reason a line is the way it is — the bug it prevents, the alternative
that was tried, the number that is not arbitrary. Read almost any file in `packages/core` for
the register we are aiming at.

Error messages are documentation that arrives at the worst moment. Say what went wrong, why it
matters, and what to do instead:

```ts
throw new Error(
  `[blaeu] plugin "${plugin.id}" is already installed. ` +
    `Two instances would each register their listeners and layers, and you would see every action happen twice.`,
)
```

## Releases

Changesets. Run `npx changeset` on every user-visible change and describe it in the terms a
_user_ experiences, not the terms the diff does. The bot handles version bumps and the
changelog.

Core is versioned strictly: **a change to a public interface in `packages/core/src/types/` is
a major**, no matter how small it looks.

## Adding a package

Package manifests are **generated, not hand-written**: `scripts/scaffold-packages.mjs` holds
the list of workspace packages and emits every `package.json`, `tsconfig.json` and
`tsup.config.ts` from one template. That is what keeps the `exports` map, the dependency
versions and — above all — the peer-dependency rule consistent across thirteen packages.

So: add your package to the list in that script, run it, and then wire the two things it does
not own — the root `workspaces` array (if the glob does not already cover it) and the
`@blaeu/*` alias in `vitest.config.ts`, without which your tests will resolve `dist`
instead of source. Check the diff.

(The root `new-package` script currently points at a file that does not exist. Fixing it — so
that a new package is scaffolded with the three tests above already wired and already failing
— is a good first PR. A package that starts with three failing tests gets them passing; one
that starts with zero tests ships with zero tests.)

Then, before you open the PR:

- `@blaeu/core` is a **peerDependency**, never a dependency.
- `"sideEffects": false`, so it tree-shakes.
- Named export `xPlugin()`, plus the `Api` and `Options` types.
- The `BlaeuPluginRegistry` augmentation, so `map.plugin('your-id')` needs no cast. Skipping
  this is the single most common way a plugin ends up feeling second-class. Do it even for
  tiny plugins.
- A README saying what it registers, what it depends on, and what events it emits.
