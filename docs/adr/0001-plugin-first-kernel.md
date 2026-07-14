# ADR 0001 — A plugin-first kernel, not a map library with a plugin API

Status: accepted · Supersedes: nothing · Superseded by: nothing

## Context

Every mapping library in the JavaScript ecosystem starts small and ends up with a
`map.enableSnapping()`. The pattern is consistent and the reason is understandable: a
concrete feature is easy to ship, an extension point is not, and the first user who asks for
snapping is asking for snapping, not for a snap-provider interface.

The cost arrives later, and it is paid by everyone. The moment `enableSnapping()` exists,
the library has decided what snapping means — for every user, for every domain, forever.
The cadastral user who needs to snap to a parcel corner registered on a server, and the game
user who needs to snap to a hex centre, both have the same two options: fork, or ship a
patch that nobody will accept because it makes the API worse for the other one.

We needed one kernel to serve a land registry, an urban-planning tool and a game level
editor. Those three have almost nothing in common except geometry: one has geodesy and legal
consequences, one has geodesy and no legal consequences, and one has no Earth at all.

## Decision

The core owns exactly five things:

1. a typed event bus with cancellable `before:` hooks,
2. a plugin registry,
3. two middleware pipelines (sync interaction, async commit),
4. a command bus,
5. a feature store (with its spatial and topology indexes).

Everything a user would call a _feature_ — drawing, snapping, editing, measurement,
selection, undo/redo, topology validation, UI chrome, and even layer _types_ — is a plugin
that registers through an extension point the core defines and the core calls. The core
never imports a plugin. CI enforces it mechanically:

```bash
npm run lint:boundaries   # fails on core→plugin, plugin→plugin, or core-as-dependency
```

Domains are **presets**: composable plain-data bundles of plugins, config, layers, rules,
theme and messages (see ADR 0006).

The test we hold ourselves to: when a plugin needs something the core does not offer, the
correct response is "the core is missing an extension point," never "add a small thing to
the core."

## Alternatives rejected

**A monolithic library with a plugin API bolted on** (the Leaflet / OpenLayers / Mapbox Draw
lineage). Cheaper to start, and it is the reason `preset-game` would have been impossible:
a monolith with drawing and measurement built in has already assumed a basemap, a geodetic
surface and a `@turf/area`, none of which a game world has. You cannot subtract a core
feature. You can decline to install a plugin.

**Inheritance — `class CadastreMap extends FlexiMap`.** Domains would override behaviour by
subclassing. Rejected because it composes exactly once: a municipality that wants the
national cadastre customisation _and_ a utilities extension has to pick a base class, and
the two hierarchies do not merge. Composition of data (presets) has no such ceiling.

**A registry of hooks without a command bus or pipelines** — i.e. events only. Rejected
because events cannot _modify_ what happens; they can only observe it. Snapping needs to
rewrite the pointer position, and validation needs to veto a write. Both require a chain
that owns the value, which is a pipeline, not an event.

## Consequences

- **Good.** A third-party plugin is exactly as first-class as a built-in one; there is no
  privileged path. `preset-game` omits `plugin-topology` entirely and the bundle does not
  carry JSTS — you genuinely do not pay for what you do not use.
- **Good.** The core is small enough to hold in your head, and its test suite runs in
  milliseconds against a fake renderer.
- **Bad.** Nothing works out of the box. `createFlexiMap({ container })` gives you a map that
  does nothing at all, which is a worse first-run experience than a library that draws by
  default. We accept it, and pay it back with presets: `preset: cadastrePreset()` is one line
  and gives a complete product.
- **Bad.** Every capability costs an interface, and interfaces are versioned. A change to
  anything in `packages/core/src/types/` is a **major**, no matter how small it looks,
  because every plugin in every downstream product implements against it.
- **Bad.** Indirection has a debugging cost. "Why did my vertex land here?" is answered by
  reading the middleware chain, not by reading the draw tool. `map.debug.interactionMiddleware()`
  exists precisely because of this.
