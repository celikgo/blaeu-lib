---
name: blaeu-renderer-seam
description: The Renderer interface, FakeRenderer, and the MapLibre implementation behind it — what the seam owns, what only a real browser and a real WebGL context can prove, and the maplibre-gl peer range CI keeps honest. Use when editing packages/core/src/renderers, when a browser test or `npm run test:browser` fails or skips, when the `peer-range` CI matrix goes red, when reaching for `getNative`, or when changing which maplibre majors are supported.
---

# The renderer seam

The most trap-laden surface in the repository, and the one where a green suite
proves the least. Everything here exists because a defect got through once: the
map never appeared on any maplibre 4 host, and 700-odd passing tests said nothing
was wrong.

## What the interface owns

`Renderer` (`packages/core/src/types/renderer.ts`) is deliberately small.
MapLibre is the only implementation shipped, and it is the right default — but the
interface exists so that a Three.js renderer for a 2.5D game map, or a headless one
for server-side rendering, is a **new package rather than a fork**. Anything that
can be built on top of the primitives — measurement, highlighting, editing handles
— is a plugin, not a renderer method.

The required members: `kind`, `mount`, `project`/`unproject`, the data and layer
calls (`setData`, `addSource`, `removeSource`, `addLayer`, `removeLayer`,
`setLayerStyle`, `setLayerVisible`), the camera (`getCamera`, `setCamera`,
`fitBounds`), hit testing (`queryAt`, `queryInBox`), events (`onPointer`,
`onCamera`), `setCursor`, `getNative` and `destroy`. Swap one in with
`createBlaeuMap({ renderer })`.

`project` and `unproject` must be **exact inverses to within the CRS's precision**.
That is not a politeness; a snap tolerance is denominated in screen pixels, and a
projection that does not round-trip makes every pixel-denominated assertion a lie.

### Three members are optional, and the kernel probes for them

`setBasemap`, `setInteraction` and `onKey` are optional, and every caller in the
kernel tests for the method rather than assuming it —
`this.renderer.setInteraction?.(…)`, `this.renderer.onKey?.(…)`, and an explicit
`typeof setBasemap !== 'function'` guard before a theme swap
(`packages/core/src/BlaeuMap.ts`).

Probe, don't require, because each of the three describes a capability a legitimate
renderer may genuinely not have. A fixed-ground game map has no basemap to swap. A
renderer with no built-in gesture handling — a fixed board, a headless test double
that only needs projection — has nothing for `setInteraction` to toggle. An export
target or a server-side canvas has no focusable surface and therefore no keyboard.
Promoting any of them to a required member would make those renderers implement a
method that throws, which is worse than the method being absent: a probe can
degrade, a throw cannot.

Two notes on the optional three that are easy to get wrong:

- A renderer that **does** implement `setBasemap` must survive the swap. MapLibre
  tears down every source and layer on a style change, so the implementation is
  responsible for re-materialising the ones this library added, with their data
  and their stacking order — and the camera must not move. Otherwise a theme
  change wipes the map.
- `dragThreshold` travels inside the interaction config but belongs to the
  interaction _pipeline_, not the renderer. An implementation should ignore it
  rather than invent an equivalent.

`onKey` is the newest of the three, and its history is the argument for the
pattern. `InteractionContext` has had a `'keydown'` kind and a `key` field from the
beginning, `dispatchToTool` has always routed it, and ten tools across five packages
implement `onKeyDown` — but no renderer ever produced a key event, so
Escape-to-cancel and Backspace-to-undo-a-vertex worked only under `map.test.key()`.
Three READMEs documented behaviour nothing delivered, and `plugin-history` gave up
and bound its own DOM listener. A declared channel with no filler is worse than an
absent one.

## Why `FakeRenderer` can prove most of the library

`FakeRenderer` (`@blaeu/core/testing`) is a complete `Renderer` with no GPU, no DOM
and no MapLibre, and the node suite — 789 tests across 44 files — runs the entire
kernel, every plugin and every preset through it in seconds. It is the proof the
seam is real rather than aspirational: **if something can only be tested with WebGL,
the abstraction has leaked, and that is a bug in the core rather than a reason to
spin up a browser.**

What makes it work is that the projection is done properly. `project`/`unproject`
implement real spherical Web Mercator against a fake camera, parameterised on
MapLibre's 512 px tile size so zoom levels stay comparable. Scaling longitude and
latitude linearly would have been far less code — and would have made every
pixel-denominated test a lie, because snapping tolerances are in **screen pixels**:
under a linear fake, "8 px from that vertex" means a different ground distance at
39°N than at 60°N, so a snap test that passed in Ankara would fail in Oslo for
reasons that have nothing to do with the snap engine. Because the two functions are
analytically invertible, a test can say _the pointer is 8 pixels from that vertex_
and mean it. Pitch is ignored (the fake is orthographic); bearing is honoured,
because a rotated map is a genuinely different hit test and tools must survive one.

The fake is also inspectable — `sources`, `layers`, and per-call counters including
`setDataCallsBySource` — which is what lets a test ask whether the `LayerManager`
coalesced 500 changes into one `setData`.

Renderers are excluded from Stryker mutation testing on purpose: their real
behaviour is MapLibre's, and MapLibre's judgement lives in the browser suite.

## What only the browser suite can prove

Exactly one surface is unverifiable through the fake, by construction: **whether
MapLibre accepts what we hand it.** A fake accepts everything, so it can only
confirm we called the method we meant to call. Our translation of `LayerStyle` into
MapLibre paint and layout keys, and our normalisation of MapLibre's pointer and
touch events into `InteractionContext`, are the two places the seam can leak — and
mocking `maplibre-gl` does not help, because the thing under test is MapLibre's own
validator.

So `npm run test:browser` runs `packages/core/src/renderers/MapLibreRenderer.browser.test.ts`
under Playwright against a real `maplibre-gl` and a real WebGL2 context: 22 tests,
one file at a time (`fileParallelism: false`, because a browser caps live WebGL
contexts at roughly sixteen and past that the oldest is silently killed, which reads
as an unrelated test flaking). It is **additive and deliberately outside
`npm run verify`** — a gate that is slow or flaky is a gate people learn to skip.
CI gives it its own `browser` job that runs unconditionally, plus the nightly
schedule.

Two rules keep it worth its runtime, and both are things a reviewer can apply:

1. **Only what the fake cannot honestly reach.** Tile-source ref-counting,
   rollback-on-failed-`addLayer` and the maplibre-4 teardown path all belong against
   the fake, where those failure modes can be induced on demand. Duplicating them
   here costs a browser launch and buys nothing.
2. **A fence, not a net.** It exists to stop defects that were found by reading the
   code from coming back, not to discover new ones. Without that rule the file grows
   into a second full suite running at a hundredth of the speed, and someone deletes
   it for being slow.

One of the 22 is an `it.fails`, left failing on purpose: a tool that drags is in a
fight with MapLibre's own drag-pan, the kernel already tracks `dragging`
([ADR 0010](../../../docs/adr/0010-tools-declare-what-they-drag.md)) and nothing
carries that to MapLibre. `it.fails` rather than `it.skip`, because a skip is
invisible and this one is a statement of intent — when the feature lands the test
starts passing, vitest flags the unexpected pass, and that is the reminder to
promote it to a real `it`.

### Why four tests are gated on a runtime GPU probe

`queryRenderedFeatures` returns only what has actually been **rendered**, so the four
hit-testing tests need a completed render pass — and headless software WebGL does not
reliably deliver one. Measured across two environments and two maplibre majors:

```
macOS + SwiftShader, maplibre 5   renders
macOS + SwiftShader, maplibre 6   never reaches loaded()
ubuntu-latest CI,    maplibre 5   never reaches loaded()
ubuntu-latest CI,    maplibre 6   never reaches loaded()
```

The axis is the **GPU, not the maplibre version**. Two earlier attempts assumed the
version and pinned v5; the second was disproved by CI, where v5 fails too. v6 is
merely stricter — it dropped WebGL1 and requires WebGL2, which is why it also fails
on the one machine where v5 works. Neither the headless shell nor the full Chromium
build changes the answer; that was measured, and the full build costs a 178 MB
download for nothing.

So the suite mounts one throwaway map, probes once for a real render pass, and
gates those four tests on the answer via `describe.runIf(canRender)`. Everything
that does not need a rasteriser — style translation, pointer normalisation, touch,
basemap swap — runs everywhere. **The skip is announced on every run**: one test
always executes and prints whether this environment can rasterise, and an
`afterAll` warns when it could not, naming what was skipped. A shrunk suite must
never be able to read as a full one; an invisible gap is the failure mode this
repository is documented against.

If you are debugging a skip, the probe is at the top of the browser test file and
the flags that give headless Chromium a WebGL2 context at all
(`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
--disable-gpu-sandbox`) are in `vitest.browser.config.ts`. Without them the context
request returns null and every test fails with "Failed to initialize WebGL", which
reads like a MapLibre bug rather than a missing flag.

## The peer range is a promise: `maplibre-gl >=4.7.0 <7`

`@blaeu/core` peer-depends on `maplibre-gl` rather than depending on it, because the
host owns the map engine and two copies of it in one page is a bug nobody enjoys
diagnosing. A peer range is therefore a promise to the host: install anything inside
it and the renderer works.

### The worked example that forced all of this

The manifest said `>=4.7.0 <6`. `MapLibreRenderer` cleaned up its listeners through
the return value of `map.on(...)` — maplibre 5's `Subscription.unsubscribe()`. On
maplibre 4, `on()` returns the map, so `destroy()` threw; the throw escaped
`whenLoaded`'s `load` handler before it could `resolve()`; so `mount()` **hung
forever on every v4 host**. Not a rendering artefact, not a degraded mode — the map
never appeared.

The suite stayed green throughout, because the fake maplibre map the renderer's own
tests use returned a v5-shaped subscription. Every test asserted the code did what
we meant it to do, against a double built from the same misunderstanding.

The fix is a guard, not a narrower range: `map.off(type, listener)` is identical on
all three majors, so `bindListeners` binds through `on` and unbinds through `off`.
The general rule follows — **anything that differs across the declared majors is
feature-detected at the call site**, because the fake cannot be trusted to model two
shapes at once.

### What keeps the range honest

The range lived in four places and nothing checked that they agreed. Now two things
do, and they are different halves of the same job:

- **`packages/core/src/renderers/peer-range.test.ts` — the cheap half.** It reads
  `packages/core/package.json` as the one source of truth and asserts the string is
  _bounded_ (`>=x.y.z <n`, never open), that `scripts/scaffold-packages.mjs` mints new
  packages against the same range, that the loader's "install a compatible version"
  error message names it, that the renderer's own teardown note documents the range
  it reasons about, and that `@blaeu/core`'s dev dependency sits inside it. This
  proves the _declarations_ agree — nothing more.
- **The `peer-range` matrix in `.github/workflows/ci.yml` — the honest half.** Three
  legs: `4.7.0` exactly (the declared floor), `^5` (the middle major), `^6` (the
  ceiling, WebGL2-only and ESM-only). Each installs with `npm i -D --no-save` so the
  matrix can never quietly rewrite the lockfile, then runs `tsc --noEmit` over
  `packages/core`. `npm ci` installs the one version the lockfile names, so without
  this matrix every other job tests exactly one point inside the range.

The dev dependency sits at the ceiling deliberately, so the default suite runs
against the strictest major the range admits and the matrix covers the floor.

Two consequences worth knowing before you touch it. Raising the ceiling is a
**coordinated change by design** — manifest, scaffold, loader message, teardown
note, plus a matrix leg, and the test stays red until the four declarations agree;
that friction is the feature, because they are supposed to be one number. And the
matrix type-checks rather than running a browser, so it catches signature drift and
not behavioural drift; behavioural differences inside the range are caught by the
browser suite or not at all.

## `getNative<T>()` is the sanctioned escape hatch

```ts
const maplibre = map.renderer.getNative<maplibregl.Map>()
maplibre.addControl(new maplibregl.NavigationControl())
```

We _want_ people to reach the underlying map — the alternative is that they fork the
library the first time we have not wrapped something. But it is explicit, greppable,
and carries a warning: you are outside the abstraction, and nothing done through it
is undoable, because the command bus never saw it. Reaching for it in library code,
rather than in an application, usually means a primitive is missing from the
interface; add the primitive instead. This is core invariant 6 — see
`blaeu-core-invariants`.

## Where the decisions are written down

- [ADR 0008](../../../docs/adr/0008-maplibre-with-a-renderer-seam.md) — MapLibre is
  the engine, behind a seam.
- [ADR 0014](../../../docs/adr/0014-maplibre-peer-range-policy.md) — the peer range
  is bounded, declared once, and checked by CI.
- [ADR 0015](../../../docs/adr/0015-browser-tests-are-a-fence-gated-on-a-gpu-probe.md)
  — the browser suite is a fence, and its hit tests are gated on a GPU probe.

For the harness itself — `createTestMap`, the fixtures, the three tests every plugin
owes — see `blaeu-testing`.
