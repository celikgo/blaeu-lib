---
name: blaeu-testing
description: Testing patterns for Blaeu — the headless map harness, the fake renderer, geometry fixtures, and the three tests every plugin owes (degradation, teardown, undo round-trip). Also covers the real-browser MapLibre suite and its WebGL GPU probe, the store benchmarks, and Stryker mutation testing. Use when writing or fixing tests anywhere in the repo, when a test needs a map instance without a browser, or when a browser test, playwright, `test:browser`, `bench` or `test:mutation` fails, skips, or trips the mutation score.
---

# Testing Blaeu

MapLibre needs a real WebGL context, which Vitest's jsdom does not have. So the
whole library is tested against a **fake renderer**, and only `MapLibreRenderer`
itself (`packages/core/src/renderers/`) is tested against real MapLibre, in a
separate browser-mode run: `npm run test:browser`. There is no renderer
_package_ — the renderer lives inside `@blaeu/core`.

That split is deliberate: it means 95% of the library — every plugin, every
preset, the store, the pipelines, undo/redo — tests in milliseconds with no GPU.

## The harness

```ts
import { createTestMap, parcelFixture } from '@blaeu/core/testing'
import { drawPlugin } from '@blaeu/plugin-draw'
import { snapPlugin } from '@blaeu/plugin-snap'

const map = await createTestMap({
  plugins: [drawPlugin(), snapPlugin({ tolerance: 10 })],
  features: { parcels: [parcelFixture('A'), parcelFixture('B')] },
  camera: { center: [32.85, 39.93], zoom: 16 }, // Ankara
})
```

`createTestMap` wires a `FakeRenderer` implementing the full `Renderer` contract
with deterministic, analytically-invertible `project`/`unproject`. That means a
test can say "the pointer is 8 pixels from that vertex" and mean it — which is
the only way to test a snapping tolerance honestly.

The fake viewport is 800×600 unless `viewport` says otherwise, and `features` are
seeded through the real command path — exactly as production data arrives, not by
writing into the store behind its back.

Drive interaction through the harness, not through DOM events:

```ts
map.test.pointerMove([32.8501, 39.9301])
map.test.pointerDown([32.8501, 39.9301])
map.test.pointerUp([32.8501, 39.9301])
map.test.click([32.8501, 39.9301])
map.test.dblClick([32.8501, 39.9301])
map.test.drag(from, to, { steps: 10 }) // emits realistic intermediate moves
map.test.key('Escape')
map.test.camera({ zoom: 18 }) // move the fake camera, as a pan/zoom would
map.test.seed('parcels', [parcelFixture('C')]) // more features, same command path
map.test.project(lngLat) // and unproject — the deterministic pair above
```

`await map.test.flush()` — **the one with correctness consequences.** The commit
pipeline is async (core invariant 4), so a test that asserts a validation veto
without awaiting `flush()` is asserting on a pipeline that has not run yet, and
it passes for the wrong reason. Await it before asserting on validation, on
derived attributes, or on anything a commit middleware writes.

## The three tests every plugin owes

**1. Degradation.** Optional dependencies really are optional.

```ts
it('draws without the snap plugin present', async () => {
  const map = await createTestMap({ plugins: [drawPlugin()] }) // no snap
  map.tools.activate('draw:polygon')
  // ...click three points, close...
  expect(map.store.collection('default').size).toBe(1)
})
```

**2. Teardown.** Removing a plugin leaks nothing.

```ts
import { expect, it } from 'vitest'
import { createTestMap } from '@blaeu/core/testing'
import { drawPlugin } from '@blaeu/plugin-draw'

it('leaks nothing on removal', async () => {
  const map = await createTestMap({ plugins: [drawPlugin()] })
  await map.remove('draw')
  // `snapshot()` returns `listeners`, `middleware`, `layers`, `plugins`, `features`.
  // `toMatchObject` is partial, so assert the ones your plugin can leak — include
  // `features: 0` if it writes preview geometry, because that is the key that catches a
  // plugin leaving handles or a rubber band in the store. A key it does *not* return —
  // `sources`, `rafHandles` — always fails, even on a plugin that leaks nothing.
  expect(map.debug.snapshot()).toMatchObject({
    listeners: 0,
    middleware: 0,
    layers: 0,
    plugins: 0,
  })
})
```

**3. Undo round-trip.** This is the one that catches real bugs.

```ts
import { expect, it } from 'vitest'
import { CommitEditCommand, MoveVerticesCommand } from '@blaeu/plugin-edit'
import type { BlaeuFeature, BlaeuMap, LngLat, VertexRef } from '@blaeu/core'

declare const map: BlaeuMap
declare const id: string
declare const previous: readonly BlaeuFeature[]
declare const next: readonly BlaeuFeature[]

it('round-trips every command', async () => {
  const before = map.store.snapshot()

  // The preview half of a drag. `(refs, from, to)` — a vertex is addressed by a
  // `VertexRef`, not by loose numbers — and `transient` says what it is: a frame that
  // draws, is never recorded, and is never validated.
  const ref: VertexRef = { feature: id, part: 0, ring: 0, index: 2 }
  const from: LngLat = [32.85, 39.93]
  const to: LngLat = [32.9, 39.9]
  map.commands.dispatch(new MoveVerticesCommand([ref], from, to, { transient: true }))

  // The durable half. On release the controller commits exactly one command through the
  // commit pipeline — the one write that validation and the preset's commit middleware
  // ever see. A non-transient `dispatch()` would write the same geometry and skip both.
  await map.commands.commit(
    new CommitEditCommand(previous, next, { type: 'edit:move-vertices', label: 'Move vertex' }),
  )
  expect(map.store.snapshot()).not.toEqual(before)

  map.plugin('history').undo()
  expect(map.store.snapshot()).toEqual(before) // deep equality, no tolerance
})
```

If `undo` can't restore _deep equality_, the command captured too little state.
Don't loosen the assertion — fix the command.

## Geometry fixtures

Live in `packages/core/src/testing/fixtures.ts`, re-exported from
`@blaeu/core/testing`. Prefer fixtures that are _nasty_ by default, because nasty
is what production sends:

- `parcelFixture()` — a clean rectangle, for happy paths.
- `sharedEdgeParcels()` — two parcels sharing a boundary exactly. The topology
  workhorse: moving a shared corner must move both.
- `sliverParcels()` — two parcels sharing a boundary _almost_ exactly, 0.4 mm
  apart. Snapping and the topology index must treat these as one corner; if a
  refactor makes this test fail, it has reintroduced slivers.
- `selfIntersectingRing()` — a bowtie. Validation must reject it, and name the
  offending coordinate.
- `duplicateVertexRing()` — consecutive identical coordinates. Must be cleaned on
  ingest, not crash a boolean op three operations later.

Three more are exported and worth knowing: `gridOfParcels()` for anything that has
to behave at scale, and `offsetMetres()` / `distanceMetres()` for building a case
in metres rather than in degrees you had to work out by hand.
`packages/core/src/testing/hostile.ts` holds deliberately malformed geometry for
robustness suites; it is **not** exported from `@blaeu/core/testing`, so reach for
it by relative path and only from inside core.

Assert coordinates with a **metric** tolerance, never a decimal-places one:

```ts
expectWithinMetres(actual, expected, 0.001) // 1 mm
```

`toBeCloseTo(lng, 6)` means something different at 39°N than at 60°N, which makes
it a latitude-dependent flake generator. Don't use it on coordinates.

## What NOT to test

Don't assert on MapLibre's internal source/layer JSON — that's testing MapLibre,
and it breaks on their minor releases. Assert on _our_ store and _our_ events.
The renderer contract is the boundary: test that we call it correctly (spy on the
`FakeRenderer`), not what MapLibre does afterwards.

## Outside the node run

`npm test` is the node suite and it is what `npm run verify` gates on. Three other
runners exist, none of them in `verify`, and each answers a question the node suite
cannot.

**`npm run test:browser`** (`vitest.browser.config.ts`) mounts a real MapLibre map
in headless Chromium for `packages/core/src/renderers/*.browser.test.ts` — style
translation, pointer normalisation, touch, basemap swap. Its rule is _only what the
fake cannot honestly reach_: a mocked `maplibre-gl` accepts everything, so a mocked
test can only confirm we called the method we meant to. Do not duplicate here a
failure `FakeRenderer` can induce. It probes once for a completed render pass and
**skips the four hit-testing tests when there is no GPU**, announcing the outcome
on every run so a shrunk suite can never read as a full one. To cover hit testing,
run it on a GPU runner. See `blaeu-renderer-seam` for why the seam is shaped this
way.

**`npm run bench`** runs the store benchmarks (`packages/core/src/store/*.bench.ts`).
Read the ratios between collection sizes, not the absolute numbers — a shared
runner's absolutes vary by more than the regressions worth catching, but `query`
and `nearest` growing logarithmically rather than linearly across 1 000 / 10 000 /
100 000 features is the shape the prose promises, and a linear ratio means the
index is being bypassed.

**`npm run test:mutation`** runs Stryker over `store/`, `crs/`, `layers/` and
`commands/`, with `break` at 65. It exists because coverage answers "was this line
run" and the question that matters is "if this line were wrong, would anything
fail" — the July audit found 86 real defects behind a green suite at 88% line
coverage, which is exactly that gap. The threshold is a **ratchet**: raise it when
a run beats it, never lower it to make a run pass. Renderers are excluded on
purpose, because their real behaviour is MapLibre's and that lives in the browser
suite.
