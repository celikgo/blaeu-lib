# ADR 0008 — MapLibre, behind a renderer seam

Status: accepted

## Context

FlexiMap has to draw. MapLibre GL is the obvious engine: open source, no licence key, vector
tiles, a mature style specification, WebGL performance, and a large ecosystem. There is no
serious argument for writing our own.

The question is not _whether_ to use MapLibre. It is whether to **admit** it — to let MapLibre
types appear in our public API, to let plugins call `map.getSource()` directly, and to let the
architecture assume that a map is a MapLibre map.

Two futures argue against admitting it, and one present:

- **The present:** MapLibre requires a real WebGL context. Vitest's jsdom does not have one.
  If MapLibre is load-bearing in the kernel, then testing the store, the pipelines, the
  command bus, snapping, undo/redo — 95% of the library, none of which is about rendering —
  requires a GPU. That is not a test suite anyone runs on every save.
- **A 2.5D game map** wants Three.js, not MapLibre. `preset-game` already exists and already
  does not want a basemap.
- **Server-side rendering / headless export** wants no GPU at all.

The counter-argument is real and deserves naming: an abstraction over a rendering engine is
the classic leaky abstraction, and a lowest-common-denominator wrapper that hides MapLibre's
expressions, its paint properties and its `queryRenderedFeatures` would be worse than no
abstraction. Users would fork on the first thing we failed to wrap.

## Decision

**MapLibre is the default and only shipped renderer, but it sits behind a `Renderer`
interface, and there is a named escape hatch out of it.**

The interface is deliberately small: mount, `project`/`unproject`, sources, layers, camera,
hit testing, pointer and camera events, `setCursor`, `getNative`, `destroy`. Anything that can
be built on those primitives — measurement, highlighting, editing handles, the snap indicator
— is a plugin, not a renderer method. If the interface grows, it is because something
genuinely cannot be built on top, and that is a high bar.

Style is expressed as a renderer-agnostic `LayerStyle` (`fill`, `line`, `circle`, `symbol`)
— plus, explicitly, a `native` escape:

```ts
readonly native?: Record<string, unknown>   // MapLibre paint/layout keys, deck.gl props
```

Using `native` couples that layer to a renderer. That is a real cost, and it is better than
the alternative: a leaky abstraction that pretends every renderer is the same one.

And the one sanctioned escape hatch from the whole abstraction (core invariant 6):

```ts
const maplibre = map.renderer.getNative<maplibregl.Map>()
maplibre.addControl(new maplibregl.NavigationControl())
```

We _want_ people to reach the underlying map. The alternative is that they fork the library
the first time we have not wrapped something. But the hatch is explicit, greppable, and
documented as "you are now outside the abstraction; we cannot undo/redo what you do here."

**`FakeRenderer` is the proof the seam is real.** It lives in `@fleximap/core/testing`,
implements the entire `Renderer` contract with deterministic, analytically-invertible
`project`/`unproject`, and the whole test suite (500+ tests) runs against it with no GPU. A
seam that only one implementation has ever gone through is not a seam; it is a wish. This one
has two, and the second one is exercised on every commit.

That property is what makes a pixel-denominated snap tolerance testable at all: a test can say
"the pointer is 8 pixels from that vertex" and mean it.

## Alternatives rejected

**Depend on MapLibre directly, no interface.** Simplest, and honest about reality. Rejected on
testability first — the entire non-rendering 95% of the library would need a GPU to test — and
on the game/3D/headless futures second. The testability argument alone would have decided it.

**A full rendering abstraction that hides MapLibre completely** (no `getNative`, no `native`
style escape). Rejected: the abstraction would have to grow a wrapper for every MapLibre
feature anyone ever wants, we would be permanently behind, and the first user who needs an
unwrapped `queryRenderedFeatures` option forks. An escape hatch that is explicit and
documented is strictly better than one that is a fork.

**Multiple renderers shipped from day one** (MapLibre + Three.js), to keep the seam honest.
Rejected as premature: a second renderer written speculatively, with no product behind it,
would be designed against our guesses rather than a real requirement. `FakeRenderer` keeps the
seam honest at a fraction of the cost, because it must implement everything the kernel
actually uses — no more, no less.

**Canvas/SVG renderer as the default**, for simplicity. Rejected: at 50 000 parcels, WebGL is
not optional.

## Consequences

- **Good.** The kernel, every plugin, every preset, the store, the pipelines and undo/redo all
  test headlessly, in milliseconds. This is the single largest quality-of-life property of the
  codebase, and it is downstream of this decision.
- **Good.** A Three.js renderer for 2.5D, or a headless renderer for SSR/export, is a **new
  package**, not a fork. The interface it must satisfy is already written down and already
  has a reference implementation that is not MapLibre.
- **Good.** `LayerManager` coalescing store changes into one `renderer.setData()` per
  microtask is a kernel concern, not a MapLibre trick, and every renderer inherits it.
- **Bad.** `MapLibreRenderer` has **no browser-mode test coverage.** Everything else is tested
  against `FakeRenderer`, which means the one place the seam could leak — our translation of
  `LayerStyle` into MapLibre paint/layout, and our normalisation of its pointer events — is
  verified by reading and by hand. This is the most valuable test we have not written, it is
  called out in the README's limitations, and it is on the roadmap.
- **Bad.** Two coordinate/style vocabularies exist, and `LayerStyle.native` is the pressure
  valve between them. Every use of it is a small coupling to MapLibre that a future Three.js
  renderer will have to answer for.
- **Bad.** `getNative()` is unrestricted. Anything done through it bypasses the store, the
  command bus and undo, and we cannot detect that it happened. That is the deal, and it is
  written on the tin.
