# ADR 0015 — The browser suite is a fence, and its hit tests are gated on a GPU probe

Status: accepted · Amends: — · Amended by: —

Extends [ADR 0008](./0008-maplibre-with-a-renderer-seam.md), whose "no browser-mode coverage"
consequence this decision retires and replaces with a narrower one.

## Context

`FakeRenderer` implements the whole `Renderer` contract, and the node suite — 789 tests across
44 files — runs the entire library through it with no GPU, in seconds. That is the single
largest quality-of-life property of the codebase and [ADR 0008](./0008-maplibre-with-a-renderer-seam.md)
exists to buy it.

It leaves exactly one surface unverified, and that surface is unverifiable by construction:
**whether MapLibre accepts what we hand it.** A fake accepts everything, so a fake can only ever
confirm that we called the method we meant to call. Our translation of `LayerStyle` into
MapLibre paint and layout keys, and our normalisation of MapLibre's pointer and touch events
into `InteractionContext`, are the two places the seam can leak, and mocking `maplibre-gl` does
not help — the thing being checked is MapLibre's own judgement.

So the suite needs a real browser, a real `maplibre-gl` and a real WebGL2 context. Which raises
the question this ADR answers: what does that suite cost, what is it allowed to contain, and
what happens on a runner that cannot rasterise.

## Decision

**The browser suite is additive, narrowly scoped, and its render-dependent tests are gated on a
runtime probe whose result is announced on every run.**

**Additive, and outside `npm run verify`.** `vitest.browser.config.ts` is a separate config
behind `npm run test:browser`. A WebGL browser is a different order of cost and flakiness from
`tsc` and a node runner, and a gate that is slow or flaky is a gate people learn to skip — at
which point it protects nothing and everyone has learned to ignore a red tick. CI runs it in its
own `browser` job on every pull request and push, with no `paths:` filter narrowing it to
`renderers/**` — what breaks the translation is rarely a change inside the renderer.

**Only what the fake cannot honestly reach.** Tile-source ref-counting,
rollback-on-failed-`addLayer` and the maplibre-4 teardown path all belong against the fake,
where those failure modes can be induced on demand. Duplicating them here costs a browser launch
and buys nothing.

**A fence, not a net.** It exists to stop defects that were found by reading the code from coming
back — not to discover new ones. That is what keeps the file from growing into a second full
suite that runs at a hundredth of the speed.

**The hit tests are gated on a probe, and the gate is on the GPU.** `queryRenderedFeatures`
returns only what has been _rendered_, so four tests need a completed render pass. Headless
software WebGL does not reliably deliver one. Measured, across two environments and two maplibre
majors:

```
macOS + SwiftShader, maplibre 5   renders
macOS + SwiftShader, maplibre 6   never reaches loaded()
ubuntu-latest CI,    maplibre 5   never reaches loaded()
ubuntu-latest CI,    maplibre 6   never reaches loaded()
```

The axis is the GPU, not the maplibre version. Two earlier attempts assumed the version and
pinned v5; the second was disproved by CI, where v5 fails too. v6 is merely stricter — it
dropped WebGL1 and requires WebGL2, which is why it also fails on the one machine where v5
works. So the suite mounts one throwaway map, probes once for a real render pass, and gates
those four tests on the answer rather than on a version number.

**The skip is reported every run.** One test always runs and prints whether this environment can
rasterise, and an `afterAll` warns when it could not, naming what was skipped. A shrunk suite
must never be able to read as a full one — that is how a gap becomes invisible, and an invisible
gap is the failure mode this whole repository is documented against.

## Alternatives rejected

**Put it in `npm run verify`.** The obvious way to make it count: one gate, no second command to
remember, no chance of the browser suite rotting unnoticed. Rejected on cost and flakiness. A
browser launch plus WebGL context creation is seconds where the node suite is milliseconds, and
`verify` is run on every save by people who will start passing `--ignore-scripts` if it stops
being fast. CI running it on renderer PRs and nightly gets the coverage without teaching anyone
to route around the gate.

**Mock `maplibre-gl` and keep everything in node.** No browser, no WebGL, no probe, and it would
run in the existing suite. Rejected because it tests nothing: a mock accepts whatever we hand it,
and "does MapLibre accept this paint key" is precisely the question. A mocked style validator is
a mirror.

**Install the full Chromium build instead of the headless shell**, on the theory that the
rasteriser is what is missing. Measured: it changes nothing, and costs a 178 MB download per run.
The headless shell fails and succeeds in exactly the same places.

**Pin maplibre 5 for the browser job**, since that is the combination that renders locally.
Rejected by measurement — see the matrix above. It renders on macOS and fails on CI, so the pin
buys a green tick that means "this ran on a machine with a GPU", which is not a fact about the
code.

**Delete the four hit-testing tests, since CI cannot run them.** Rejected because they cover the
highest-value assertion in the file: MapLibre's GeoJSON source coerces a non-numeric feature id
unless told otherwise, so a cadastral id like `"00123"` silently becomes the number `123` and the
leading zero is gone from every hit test in the product. A test that is skipped and announced is
worth more than one that was never written, because the announcement is what gets it run on a
GPU runner eventually.

## Consequences

- **A green local run and a green CI run are not the same run**, and both say so. Locally on a
  machine with a GPU the four hit tests execute; on CI they skip and the console says which ones
  and why.
- **Hit testing is verified by hand and by one developer's machine**, which is the honest
  residual gap left by [ADR 0008](./0008-maplibre-with-a-renderer-seam.md). Closing it needs a
  GPU runner, and that is one of the preconditions for taking 1.0 deliberately — see
  [ADR 0016](./0016-one-lockstep-version-for-the-whole-kernel.md).
- **The suite runs one file at a time.** Each test mounts a real `Map`, and a browser caps live
  WebGL contexts at roughly sixteen; past that the oldest is silently killed and the failure
  reads as an unrelated test flaking. Serialising is cheaper than debugging that, and it is why
  this suite will never be the place to add breadth.
- **Adding a test here needs an argument.** "Only what the fake cannot honestly reach" is a rule
  a reviewer can apply, and without it the file grows until someone deletes the whole thing for
  being slow.
