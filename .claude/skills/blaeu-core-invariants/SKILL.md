---
name: blaeu-core-invariants
description: The six non-negotiable rules of the BlaeuMap kernel — what may never be imported, mutated, or bypassed. Read BEFORE editing anything under packages/core, or when a change is tempted to "just add one small thing" to the core to make a plugin work.
---

# Core invariants

The value of this library is entirely in what the core _refuses_ to do. Every one
of these rules has been broken by some other mapping library, and each break is
why that library is now unextensible. Treat them as load-bearing.

## 1. The core never imports a plugin. Ever.

`packages/core` has exactly one runtime dependency graph: itself. If core needs
to know something a plugin knows, the plugin **registers** it (a snap provider, a
layer type, a validation rule, a command), and core calls it through an interface
core owns.

The check is mechanical, and CI runs it:

```bash
grep -rE "from '@blaeu/(plugin|preset)-" packages/core/src && exit 1
```

If you find yourself wanting to import the draw plugin into core, the real
request is "core is missing an extension point." Add the extension point.

## 2. Nothing mutates the store directly. Everything is a Command. Durable writes `commit`; only scaffolding `dispatch`.

```ts
map.store.collection('parcels').get(id)!.geometry.coordinates[0][2] = [x, y] // ✗ invisible
map.commands.dispatch(new AddFeaturesCommand('parcels', [p])) // ✗ won't compile
await map.commands.commit(new AddFeaturesCommand('parcels', [p])) // ✓
```

Direct mutation is not "faster" — it is _invisible_. It skips the commit
pipeline, so validation never runs; it skips the command bus, so undo has no
record; it skips the store's change events, so the renderer never repaints. The
bug surfaces three user-actions later as "undo is broken," and it is miserable to
trace.

**There are two write paths, and picking the wrong one is the same bug wearing a
disguise.**

|                     | `dispatch(cmd)`                            | `commit(cmd)`                      |
| ------------------- | ------------------------------------------ | ---------------------------------- |
| Sync?               | yes — runs on `pointermove`                | no, `await` it                     |
| Commit pipeline     | **skipped**                                | **runs**                           |
| Validation can veto | no                                         | yes                                |
| For                 | previews, handles, highlights, hover state | anything that survives the gesture |

A command that writes durable features implements `CommitCommand` (it declares an
`intent()` and can `adopt()` what middleware rewrote). `dispatch()` **refuses one
at compile time** — `intent?: never` in its signature — and throws at runtime for
JavaScript callers. That refusal is not pedantry. It is the only thing standing
between you and a product whose validation rules are all registered, all correct,
and never consulted.

Rule of thumb: **if it survives the gesture, it commits.** A rubber band does not.
A parcel does.

Every command must satisfy `undo(execute(s)) === s` by **deep equality**. If it
can't, the command captured too little state. See `blaeu-testing`.

### Why this is stated so emphatically

For a while, `AsyncCommitPipeline` was constructed by the kernel, preset
middleware was registered into it, and the validation registry installed itself
into it — and **nothing ever called `run()`**. Every part had tests. Every test
passed. The parts were right and the wire between them did not exist, so the
library had no validation at all: rules were registered, never consulted, and the
only symptom was a rule that never fired — which is indistinguishable from a rule
with nothing to complain about.

The cadastre preset's `deriveAreaMiddleware` was correct and dead, so a parcel's
`yüzölçümü` was whatever the caller typed, and it survived arbitrary edits to the
geometry. The deed said 2000 m² for a parcel that was 8012 m².

**The test that would have caught it does not construct a middleware and call it.**
That tests the middleware, not the wiring. It goes through the public API and
asserts on `map.store` — the one thing that cannot lie about whether the write
happened. See `packages/core/src/commands/commit.test.ts`.

## 3. Interior CRS is WGS84 lng/lat. Precise maths happens in the working CRS.

The store, the events, and the renderer speak `[lng, lat]` in EPSG:4326, always.
No exceptions, because the moment two coordinate systems flow through the same
pipe, everything downstream must ask "which one is this?" and eventually
something guesses wrong.

But _sphere maths is not survey maths_. Area, offset, parallel lines, and
perpendicular feet computed on a sphere are wrong at the centimetre level, which
is exactly the level a land registry cares about. So:

```ts
const plane = map.crs.working // e.g. EPSG:5254 (TUREF / TM30)
const [x, y] = plane.forward(lngLat) // → metres
// ... do the precise planar geometry here ...
const back = plane.inverse([x, y]) // → lng/lat, back into the store
```

Rule of thumb: **anything a surveyor would sign** goes through `map.crs.working`.
Anything cosmetic (hover highlight, label placement) can stay in 4326.

## 4. The interaction pipeline is synchronous. The commit pipeline is not.

`SyncPipeline` runs on every `pointermove` — up to 120 times a second. An `async`
middleware there introduces a frame of latency and reorders events under load,
which shows up as the cursor "lagging behind" the snap indicator. The type system
forbids it: interaction middleware returns `void`, not `Promise<void>`.

`AsyncPipeline` runs on commit, where a middleware may legitimately need to call a
server (a topology check against the parcel registry, say). It is allowed to be
slow, and callers `await` it — `commands.commit()` returns a `Promise`.

This is why the durable-write API is async and the interaction API is not, and why
that asymmetry is load-bearing rather than an inconsistency to be tidied away. A
tool handler stays synchronous and fires the commit without awaiting it
(`void session.complete(...)`); the map updates on the resulting event when the
write lands. Do not "fix" this by making the interaction pipeline async.

If a piece of interaction middleware genuinely needs async work, it must do it
_speculatively_ off the pipeline and cache the result — see how the snap engine
prefetches its spatial index on `camera:idle` rather than on `pointermove`.

## 5. Every subscription returns a `Disposable`, and the plugin owns it.

```ts
setup(ctx) {
  ctx.disposables.add(ctx.events.on('feature:added', onAdd))
  ctx.disposables.add(ctx.interaction.use(snapMiddleware, { priority: 100 }))
  ctx.disposables.add(ctx.renderer.addLayer(...))
}
```

`ctx.disposables` is disposed automatically on `destroy()`. A plugin that
registers a listener without adding it to `ctx.disposables` leaks it forever, and
worse, a re-registered plugin then runs its handler twice. The teardown test in
`blaeu-testing` exists to catch precisely this, and it is not optional.

## 6. Public API is the `index.ts` barrel. Deep imports are not API.

If it isn't exported from `packages/core/src/index.ts` it is internal, may change
in a patch release, and plugins may not reach for it. `exports` in `package.json`
enforces this at the module-resolution level, so a deep import fails at build
time rather than at upgrade time.

The one sanctioned escape hatch is deliberate and named:

```ts
const maplibre = map.renderer.getNative<maplibregl.Map>()
```

We _want_ users to reach the underlying map — pretending otherwise just makes them
fork. But the escape hatch is explicit, greppable, and documented as
"you are now outside the abstraction; we cannot undo/redo what you do here."

## When a rule genuinely blocks you

It happens. The answer is to change the _contract_ deliberately — add the
extension point, write the ADR under `docs/adr/`, version it — not to bypass the
rule locally. A local bypass is invisible to the next person; a changed contract
is not.
