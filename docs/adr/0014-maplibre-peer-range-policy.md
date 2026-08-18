# ADR 0014 — The maplibre-gl peer range is bounded, declared once, and checked by CI

Status: accepted · Amends: — · Amended by: —

Extends [ADR 0008](./0008-maplibre-with-a-renderer-seam.md), which decided _that_ MapLibre is
the engine but said nothing about _which versions_ of it.

## Context

`@blaeu/core` does not depend on `maplibre-gl`; it peer-depends on it, because the host owns the
map engine and two copies of it in one page is a bug nobody enjoys diagnosing. A peer range is
therefore a promise made to the host: install anything inside this range and the renderer works.

We broke that promise once, and the shape of the failure is the whole reason this ADR exists.
The manifest said `>=4.7.0 <6`. `MapLibreRenderer` cleaned up its listeners through maplibre 5's
`Subscription.unsubscribe()` — the return value of `map.on(...)`. On maplibre 4, `on()` returns
the map, so `destroy()` threw; the throw escaped `whenLoaded`'s `load` handler before it could
resolve; and `mount()` therefore hung forever on **every v4 host**. Not a rendering artefact, not
a degraded mode — the map never appeared.

The suite stayed green throughout, because the fake maplibre map the renderer's own tests use
returned a v5-shaped subscription. Every test asserted the code did what we meant it to do
against a double built from the same misunderstanding.

Two things were wrong, and only one of them was the listener teardown. The other was that the
range lived in four places — the manifest, the scaffold that mints new packages, the loader's
"install a compatible version" error message, and the teardown note in the renderer explaining
which majors it reasons about — and nothing checked that the four agreed.

## Decision

**The peer range is bounded, it is declared in one place, and both halves of that are
mechanically enforced.**

```jsonc
// packages/core/package.json
"peerDependencies": { "maplibre-gl": ">=4.7.0 <7" }
```

- **Bounded, never open.** `packages/core/src/renderers/peer-range.test.ts` asserts the declared
  string matches `>=x.y.z <n` and fails on anything else. An unbounded `>=4.7.0` is a promise
  about majors that do not exist yet, and the v4 incident is what that promise costs when it
  turns out to be wrong.
- **Declared once, asserted identical in four places.** The same test reads the manifest as the
  one source of truth and checks it against `scripts/scaffold-packages.mjs` (so a package minted
  after a bump cannot silently disagree with the core), against the loader's error message (so a
  user is not told to install a version the manifest rejects), and against the renderer's own
  teardown note (so the code documents the range it actually reasons about). It also checks that
  `@blaeu/core`'s dev dependency — the version the default CI leg installs — sits inside the
  declared range, or the suite is testing something the library does not claim to support.
- **CI compiles against the floor and the ceiling.** The `peer-range` matrix in
  `.github/workflows/ci.yml` installs `4.7.0` exactly, `^5` and `^6` with `npm i -D --no-save`
  and type-checks the renderer against each. `npm ci` installs the one version the lockfile
  names, so without this matrix every other job tests exactly one point inside the range.

The test is the cheap half and the matrix is the honest half. The test proves the four
_declarations_ agree; only the matrix proves the code compiles against what they declare.

## Alternatives rejected

**An open range, `>=4.7.0`.** Maximally permissive, and it never needs touching. Rejected
because it is a claim about majors that have not been written — including the one that will
remove the API we depend on. A peer range that cannot be false is not a promise, it is a
disclaimer, and the host finds out at runtime.

**Pin a single major, `^6`.** Honest, checkable, and it would have made the v4 incident
impossible by construction. Rejected because MapLibre 4 and 5 are still widely deployed and a
host does not get to choose its map engine's version independently of the rest of its
application. Supporting three majors is the cost of being a library rather than an application.

**Drop v4 and set the floor at 5.** Tempting immediately after the incident, since v4 is what
broke. Rejected because it mistakes the symptom for the cause: the defect was a version-specific
API used without a version-specific guard, and it would have happened at the v5/v6 boundary just
as readily. The fix is the guard and the matrix, not a narrower range.

**Check the four declarations by review.** That is what we were doing. It survives exactly as
long as the person who bumps the manifest remembers all four places, and the last person did
not.

## Consequences

- **A major bump is a coordinated change, deliberately.** Raising the ceiling means editing the
  manifest, the scaffold, the loader message and the teardown note, plus a CI matrix leg — and
  the test fails until all four agree. That friction is the feature: the four are supposed to be
  one number.
- **The renderer must guard version-specific API rather than assume it.** Anything that differs
  across the declared majors — `on()`'s return value is the known case — is feature-detected at
  the call site, because the fake cannot be trusted to model both shapes at once.
- **Three majors is three shapes of bug.** The matrix type-checks, it does not run a browser, so
  it catches signature drift and not behavioural drift. Behavioural differences inside the range
  are caught by the browser suite ([ADR 0015](./0015-browser-tests-are-a-fence-gated-on-a-gpu-probe.md))
  or not at all.
- **The dev dependency is a choice, not an accident.** It sits at the ceiling (`^6.4.0`), so the
  default suite runs against the strictest major the range admits and the matrix covers the
  floor.
