---
name: blaeu-testing
description: Testing patterns for BlaeuMap — the headless map harness, the fake renderer, geometry fixtures, and the three tests every plugin owes (degradation, teardown, undo round-trip). Use when writing or fixing tests anywhere in the repo, or when a test needs a map instance without a browser.
---

# Testing BlaeuMap

MapLibre needs a real WebGL context, which Vitest's jsdom does not have. So the
core is tested against a **fake renderer**, and only the renderer package itself
is tested against real MapLibre (in a browser-mode run).

That split is deliberate: it means 95% of the library — every plugin, every
preset, the store, the pipelines, undo/redo — tests in milliseconds with no GPU.

## The harness

```ts
import { createTestMap } from '@blaeu/core/testing'

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

Drive interaction through the harness, not through DOM events:

```ts
map.test.pointerMove([32.8501, 39.9301])
map.test.click([32.8501, 39.9301])
map.test.drag(from, to, { steps: 10 }) // emits realistic intermediate moves
map.test.key('Escape')
```

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
it('leaks nothing on removal', async () => {
  const map = await createTestMap({ plugins: [drawPlugin()] })
  await map.remove('draw')
  expect(map.debug.snapshot()).toMatchObject({
    listeners: 0,
    sources: 0,
    layers: 0,
    middleware: 0,
    rafHandles: 0,
  })
})
```

**3. Undo round-trip.** This is the one that catches real bugs.

```ts
it('round-trips every command', async () => {
  const before = map.store.snapshot()
  map.commands.dispatch(new MoveVerticesCommand(id, 0, 2, [32.9, 39.9]))
  expect(map.store.snapshot()).not.toEqual(before)
  map.plugin('history').undo()
  expect(map.store.snapshot()).toEqual(before) // deep equality, no tolerance
})
```

If `undo` can't restore _deep equality_, the command captured too little state.
Don't loosen the assertion — fix the command.

## Geometry fixtures

Live in `packages/core/src/testing/fixtures/`. Prefer fixtures that are _nasty_
by default, because nasty is what production sends:

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
