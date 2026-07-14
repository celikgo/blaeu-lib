# Architecture

This document explains how FlexiMap is put together and, more usefully, _why_. It assumes
you have read the [README](README.md).

The short version: the kernel owns five things and refuses to own a sixth. Everything a
user would call a feature is built on top of them, from the outside, through extension
points the kernel defines and the kernel calls. The value of the library is entirely in
what the core declines to do.

---

## 1. The kernel

`FlexiMap` (`packages/core/src/FlexiMap.ts`) is a class with fifteen fields and no
`draw()`, no `measure()`, no `snapTo()`. Read the field list and notice the absences:

```ts
class FlexiMap {
  readonly events: FlexiEventBus
  readonly store: FlexiFeatureStore
  readonly commands: FlexiCommandBus
  readonly plugins: FlexiPluginManager
  readonly interaction: SyncInteractionPipeline
  readonly commit: AsyncCommitPipeline
  readonly tools: FlexiToolManager
  readonly layers: FlexiLayerManager
  readonly crs: FlexiCrsService
  readonly theme: FlexiThemeManager
  readonly i18n: FlexiI18n
  readonly validation: FlexiValidationRegistry
  readonly renderer: Renderer
  readonly config: ResolvedConfig
  readonly log: Logger
}
```

The first six are the kernel proper. The rest are _seams_: services with an interface the
core owns, which plugins extend rather than replace.

`createFlexiMap()` is async because the renderer must mount and every plugin's `setup` must
finish before the map is usable — and a plugin's setup may legitimately fetch a projection
definition or warm a spatial index. Returning a half-initialised map from a synchronous
constructor and hoping the caller awaits the right thing is how you get bug reports that
say "sometimes the first click does nothing."

### EventBus

Strongly typed through declaration merging on `FlexiEventMap`. Plugins augment the map from
their own entry point, and thereby teach the core's bus about events the core has never
heard of:

```ts
declare module '@fleximap/core' {
  interface FlexiEventMap {
    'draw:complete': { readonly mode: DrawMode; readonly feature: FlexiFeature }
    'before:draw:complete': { readonly mode: DrawMode; readonly feature: FeatureInput }
  }
}
```

Two channels, and the type system keeps them apart:

- `on(type, handler, options?)` — past-tense notification. Cannot be cancelled.
- `onBefore(type, handler, options?)` — a cancellable hook. The handler receives a
  `CancellableFlexiEvent` with `preventDefault(reason?)`. `emitCancellable()` accepts only
  keys matching `` `before:${string}` ``, so the `before:` prefix _is_ the capability, not a
  naming convention we ask people to respect.

`ListenerOptions.priority` (higher first) exists chiefly for `before:` hooks, where the
order decides which validator vetoes first and therefore which error message the user
actually sees. Handlers are synchronous by design: the bus sits on the hot path, and an
async handler would silently reorder under load.

Every `on`/`onBefore`/`onAny` returns a `Disposable`. `listenerCount()` exists so the
teardown test can assert it returns to zero.

### FeatureStore

The single source of truth for geometry. A `FlexiFeature` is GeoJSON-_shaped_ but not
GeoJSON: `geometry` and `properties` are exactly the RFC 7946 fields, so `toGeoJSON()` is a
projection rather than a conversion, but a mandatory string `id` and a `meta` block
(collection, version, timestamps, `locked`, `hidden`, a namespaced `ext` slot) are ours.
Keeping our bookkeeping out of `properties` means a round-trip through GeoJSON does not
ship our internals to the user's server, and does not collide the day a cadastral schema
legitimately has a field called `version`.

Features live in **collections**, which map 1:1 to renderer sources and are the unit of
styling. `Collection.query(bbox)` is backed by an rbush `SpatialIndex` — O(log n), because
it is on the `pointermove` path and a 50 000-parcel linear scan is not.

Reads return frozen objects in development, so mutating one fails loudly rather than
silently desyncing the renderer and breaking undo three actions later. The write path
(`_add` / `_update` / `_remove`) is marked `@internal`: commands call it, application code
does not.

### TopologyIndex

`store.topology` maps a **quantised** coordinate to every `VertexRef` sitting on it —
`at(point)`, `featuresAt(point)`, `isShared(point)`. The quantisation grid is the working
CRS's precision (1 mm for cadastre), and it is the load-bearing detail: exact float
equality would treat corners 10⁻¹² m apart as distinct, they would drift apart under
editing, and you would have manufactured a sliver. This index is what makes
`editPlugin({ topological: true })` possible.

### CommandBus

`dispatch(command)` returns `{ ok, value, rejectedReason }`. It holds **no undo stack** —
`onDidExecute` is the seam history subscribes to. `transaction(label, fn)` groups everything
dispatched inside `fn` into one atomic, single-undo unit and rolls the store back if `fn`
throws. A one-command transaction collapses rather than wrapping, because the undo menu
should say "Move vertex", not "Transaction".

`CompositeCommand.undo()` walks its children in **reverse**. Undoing "remove A, add B"
forwards would try to re-add A while B still occupies its geometry, which a topology
validator would correctly reject.

`_apply(command, 'undo' | 'redo')` is the internal replay hook the history plugin uses. It
deliberately bypasses the `before:command:execute` gate: a hook that vetoed the original
command never saw it execute, so there is nothing to veto on the way back.

### The two pipelines

Both are Koa-style: each middleware gets `(ctx, next)` and may call `next`, skip it, or wrap
its own work around it. Both sort by descending priority. Both refuse a double `next()`,
because a middleware that calls it twice would run the rest of the chain again and
double-apply the snap offset — silent, and horrible to find.

**`SyncInteractionPipeline`** — `run(ctx: InteractionContext): InteractionContext`.
Synchronous by contract (`void`, not `Promise<void>`). Runs on every pointer event. A
middleware that throws is logged and the pipeline continues: a partly-processed pointer
event is far better than a dead cursor.

**`AsyncCommitPipeline`** — `run(ctx: CommitContext): Promise<CommitContext>`. Short-circuits
the moment anything sets `ctx.rejected`, which is why priority ordering puts cheap local
rules ahead of expensive server ones. A middleware that _throws_ rejects the write: failing
closed is the only defensible default when the thing being guarded is a land registry.

### PluginManager

Installs, resolves dependencies, runs the lifecycle: `setup` once → `enable`/`disable` any
number of times → `destroy` once. Covered in detail in §4.

The `disable`/`destroy` split matters more than it looks. `disable` means "go dormant but
**keep your state**" — a user toggling the measurement tool off and on again expects their
measurements to still be there, and a user toggling history off has not asked us to forget
what they did. `destroy` means "you are gone, release everything."

### The seams

| Seam         | Interface            | What a plugin does with it                                       |
| ------------ | -------------------- | ---------------------------------------------------------------- |
| `renderer`   | `Renderer`           | Draws. MapLibre ships; `FakeRenderer` proves the seam is real.   |
| `crs`        | `CrsService`         | `register()` a custom plane; `working.forward/inverse` for maths |
| `layers`     | `LayerManager`       | `registerType()` a whole new rendering category                  |
| `tools`      | `ToolManager`        | `register()` an interactive mode                                 |
| `validation` | `ValidationRegistry` | `add()` a rule that runs in the commit pipeline                  |
| `theme`      | `ThemeManager`       | `token()` instead of hardcoding a colour                         |
| `i18n`       | `I18n`               | `register()` a message bundle; presets override it               |

`ToolManager` keeps exactly one primary tool active at a time, which is what makes a map
feel coherent rather than like modal soup. Ambient behaviour that should always run — hover
highlighting, the snap indicator — is not a tool; it is middleware.

`ThemeTokens` feed **both** the UI chrome (as CSS custom properties) **and** the map styling
(as values inside paint expressions). That single source of truth is why the selection halo
on the map is exactly the same blue as the selected row in the attribute table — a detail
you cannot get if the map style and the CSS are maintained separately.

---

## 2. The life of a pointer event

A `pointermove` at 120 Hz, traced from the DOM to the tool. This path, and the one in §3,
explain most of the library between them.

### 2.1 The renderer normalises

`MapLibreRenderer` (or `FakeRenderer`) listens to MapLibre's own pointer events and emits a
`RendererPointerEvent`: `{ kind, lngLat, screen, button, modifiers, originalEvent }`. Mouse,
touch and pen are already unified here. **No tool ever sees a raw DOM event**, which is what
makes a tool written for a mouse work on a tablet in the field without changes.

`FlexiMap.#wireInteraction()` subscribes once, in `#init`, and holds the `Disposable`.

### 2.2 The kernel builds an InteractionContext

`FlexiMap.#normalise(event)` constructs the context handed down the pipeline. Three of its
properties are worth reading closely:

```ts
{
  get lngLat() { return lngLat },      // MUTABLE — the whole point
  set lngLat(value) { lngLat = value },
  get xy() { return crs.working.forward(lngLat) },   // DERIVED, never cached
  readonly rawLngLat: event.lngLat,    // the untouched original
  readonly screen: event.screen,       // ground truth; middleware must not rewrite it
  snap: undefined,                     // filled in by the snap middleware
  hits: () => this.renderer.queryAt(event.screen),   // lazy hit test
  consume(): void,                     // stops the event reaching the tool at all
}
```

`lngLat` is mutable because rewriting it is the entire mechanism of §2.3. `xy` is a getter
rather than a cached field so it cannot drift out of sync when middleware moves `lngLat` —
a stale `xy` that a snap middleware forgot to update is a wonderfully subtle way to place a
vertex a metre from where the user clicked. And the `crs` _service_ is captured rather than
`crs.working`, so a mid-gesture `setWorking()` is reflected on the next read.

### 2.3 The interaction pipeline runs — and rewrites the position

`this.interaction.run(ctx)` walks the middleware in descending priority.

**Snapping, priority 100.** The snap plugin's single middleware
(`packages/plugin-snap/src/engine.ts`):

1. If snapping is off, or the event is a `keydown`, or **Alt is held**, it publishes "no
   snap" and calls `next()`. Alt-to-suppress is the universal CAD convention, and handling
   it here, once, is what gives every tool the behaviour for free.
2. Otherwise it queries every registered `SnapProvider` with `(ctx.rawLngLat, tolerancePx, q)`.
   Note `rawLngLat`: a provider must see where the pointer _actually_ is, not where a
   previous frame's snap left it, or the snap would be sticky.
3. The `SnapQueryContext` hands each provider `project`/`unproject`, a precomputed `bbox` of
   the tolerance circle (so the provider hits the spatial index instead of scanning),
   `exclude` (the feature being dragged — otherwise it snaps to itself, at distance zero,
   every time), and `inProgress` (the ring's committed vertices, so the user can close a
   polygon on its own first corner).
4. Candidates are ranked by `distancePx`, ties broken by `priority`. The ordering is the
   one decision the whole engine rests on: **vertex (100) > intersection (90) > midpoint
   (80) > edge (70) > extension/perpendicular (50) > grid (10)**. A vertex must outrank the
   edge it sits on, because the perpendicular foot of a pointer near a corner is at
   _exactly_ the same screen distance as the corner — a tie broken by distance alone would
   hand a coin flip to the edge, and nobody could ever reliably snap to a corner.
5. It writes `ctx.snap = { candidate, alternatives }` and — the load-bearing line —
   **`ctx.lngLat = candidate.point`**. Then `next()`.

**Anything downstream reads a snapped position.** A grid-lock middleware, an ortho-constraint
middleware, or a coordinate-quantisation middleware registers below 100 and can therefore
override the snap deliberately; registering _above_ it would let a constraint move the
pointer off the corner the indicator is promising, which the user reads as the software
lying to them.

**The UI pointer feed** (`plugin-ui`) is another middleware. It publishes the _post_-pipeline
position to the coordinate readout, because a readout showing a different number from the
one that gets stored is worse than no readout at all.

Any middleware may call `ctx.consume()`, and the tool then never sees the event.

### 2.4 The active tool

```ts
this.interaction.run(ctx)
if (ctx.consumed) return
const tool = this.tools.activeTool
if (!tool) return
dispatchToTool(tool, ctx) // → tool.onPointerMove?.(ctx), etc.
```

The draw tool reads `ctx.lngLat`. It gets a position that is already exactly on the parcel
corner, quantised to the millimetre grid, and constrained to whatever the preset installed.
It has never heard of the snap plugin, does not import it, and would keep working if you
uninstalled it.

**This is why a tool implementation is forty lines.** All the hard geometry happened
upstream, in middleware that every tool shares.

The only thing the draw plugin tells the snap plugin is what is in flight
(`setInProgress(vertices)`) and what to ignore (`exclude([previewId])`) — and it does even
that through a duck-typed handle (`plugin-draw/src/snap-handle.ts`), obtained via
`ctx.tryPlugin('snap')`, so the dependency stays optional and the degradation test stays
honest.

---

## 3. The life of a mutation

A drawn polygon, from the tool to the pixels.

### 3.1 The tool builds a FeatureInput and fires the cancellable hook

`DrawSession.complete()` (`plugin-draw/src/session.ts`):

```ts
const input: FeatureInput = {
  geometry,
  properties: { ...options.properties() },
  meta: { source: 'draw' },
}

const gate = ctx.events.emitCancellable('before:draw:complete', {
  mode,
  collection,
  feature: input,
})
if (!gate.allowed) {
  this.cancel(gate.reason ?? 'vetoed by a before:draw:complete listener')
  return undefined
}
```

The hook fires **before** anything is dispatched, so a listener that calls `preventDefault()`
leaves nothing behind: no feature, no history entry, no half-written collection. The payload
carries a `FeatureInput`, not a `FlexiFeature` — the store has not minted an id or stamped a
version yet, and pretending otherwise would hand listeners an id no later event will ever
mention.

The rubber-band preview is cleared here, _before_ the transaction, and its command is
`transient`, so it never appears in a snapshot history would roll back to.

### 3.2 The command bus

```ts
const result = ctx.commands.transaction(label, () => {
  const dispatched = ctx.commands.dispatch(new AddFeaturesCommand(collection, [input], { label }))
  if (!dispatched.ok)
    throw new Error(dispatched.rejectedReason ?? 'the command bus rejected the shape')
  created = dispatched.value?.[0]
})
```

`FlexiCommandBus.dispatch()`:

1. `emitCancellable('before:command:execute', { command })`. **A veto here costs nothing to
   clean up** — the store has not been touched. This is where a permission check or a
   business rule belongs.
2. Inside a transaction, the command executes immediately (so later commands in the
   transaction see its effect) but is recorded into the group rather than announced
   individually.
3. Outside one, it executes, and — unless `transient` — notifies `onDidExecute` subscribers
   and emits `command:executed`.
4. Throwing inside a transaction restores the up-front store snapshot and returns
   `{ ok: false }`. A half-completed parcel split cannot be left on screen.

### 3.3 The commit pipeline

`AsyncCommitPipeline` is where attribute defaults, precision reduction, audit stamps and
**validation** live. Middleware receives a mutable `CommitContext`:

```ts
{
  readonly operation: 'add' | 'update' | 'remove',
  features: FlexiFeature[],              // mutable — rewrite them
  readonly previous: readonly FlexiFeature[],
  readonly command: Command | undefined,
  reject(reason: string): void,
  readonly rejected: boolean,
}
```

Two things register there today:

- `FlexiValidationRegistry.asCommitMiddleware()`, at priority **−100** so it runs _last_.
  That is deliberate: the middleware that fills in defaults, quantises coordinates and
  rewinds ring winding order all sit above zero, and a rule that judged the pre-quantised
  ring while the store keeps the quantised one is a bug you find in production, in a land
  registry. It emits `validation:failed` with _every_ issue (warnings ride along with the
  errors, because a UI wants to say "sliver, 0.4 m²" even when the write succeeds), and
  calls `ctx.reject()` only if an `error` is present. Removals are never validated —
  validating a delete would make an already-invalid parcel impossible to remove, which is
  the exact opposite of what a data steward cleaning up a bad import needs.
- The cadastre preset's `deriveAreaMiddleware`, above it, which recomputes `yuzolcumu` from
  the geometry on every write. Area is _derived_, never typed: a hand-entered area that
  disagrees with the boundary is the single most common source of a cadastral dispute, and
  the cheapest way never to have one is to make the field un-typeable.

**Where it runs, honestly.** `Command.execute()` is synchronous and the pipeline is async,
so `dispatch()` does not run the pipeline itself. A write that must be validated runs the
pipeline explicitly _before_ dispatching, and dispatches only if it survived —
`preset-game`'s `EntitySession.place()` is the reference implementation:

```ts
const commit = createCommitContext([feature])
await ctx.commit.run(commit)
if (commit.rejected) return [] // nothing was ever written

ctx.commands.transaction(label, () => {
  for (const [collection, features] of groupByCollection(commit.features)) {
    ctx.commands.dispatch(new AddFeaturesCommand(collection, features, { label }))
  }
})
```

This is a genuine sharp edge in the kernel, not a subtlety we are proud of; it is called out
in the README's limitations and on the roadmap. The seam and the semantics are right; the
ergonomics are not, and fixing them is a contract change that will get its own ADR.

### 3.4 The store writes, and announces

`AddFeaturesCommand.execute()` calls `store._add(collection, inputs)`, which mints ids,
stamps `meta`, quantises coordinates to the working CRS's grid, normalises ring winding and
closure, updates the spatial index and the topology index, and emits `feature:added` plus a
`StoreChange` to `onChange` subscribers.

The command keeps what the store _actually wrote_ — not what it was asked to write. That is
the difference between a command that can undo approximately and one that can undo exactly:
on redo, `AddFeaturesCommand` re-adds the features the store minted the first time, so redo
does not resurrect the parcels under _new_ ids, leaving every selection and label that
referenced the old ones dangling.

### 3.5 The LayerManager coalesces, and the renderer draws

`FlexiLayerManager.connectStore()` subscribes to `store.onChange`, marks the changed
collection dirty, and flushes on a `queueMicrotask`. A transaction that writes forty
features to one collection therefore produces **one** `renderer.setData()` call, not forty.
Teardown sets a `stopped` flag, because a queued flush after destroy would talk to a
destroyed renderer.

`setData(sourceId, features)` is the end of the road. `MapLibreRenderer` translates our
renderer-agnostic `LayerStyle` into MapLibre paint/layout, filters out `meta.hidden`
features, and hands the rest to a GeoJSON source.

### 3.6 History, which was watching the whole time

The history plugin subscribed to `commands.onDidExecute` in its `setup`. It saw a
`Command`. It pushed it onto a stack, possibly coalescing it into the previous one
(`coalesceWith`, within a 300 ms window). It knows nothing about polygons, parcels or draw
tools, and it never will.

---

## 4. Plugin dependency resolution, and why parking beats a topological sort

A plugin declares dependencies as `{ id, range?, optional? }`. `PluginManager.use()` does
**not** fail when one is missing. It _parks_ the plugin:

```ts
const missing = this.#missingDependencies(plugin)
if (missing.length > 0) {
  return new Promise<TApi>((resolve, reject) => {
    this.#pending.push({ plugin, options, resolve, reject })
  })
}
return await this.#install(plugin, options)
```

Every successful install then drains the parking lot (`#drainPending`), looping until a
pass makes no progress — so a chain A→B→C installs correctly no matter what order the three
arrive in. The promise a parked plugin returned resolves when it finally installs.

`FlexiMap.#init()` installs every preset and user plugin with `Promise.all`, then calls
`plugins.settle()`. Anything still parked at that point has a dependency that is never
coming, and `settle()` throws with a report naming each plugin and what it is waiting for —
rather than leaving a plugin sitting inert and being blamed on something else three hours
later.

**Why not topologically sort the batch up front?** Because a sort assumes you have the whole
batch. That is true for a preset and false for everything else: `map.use(plugin)` at
runtime, a lazily-loaded feature module, a plugin marketplace that installs on demand. A
topological sort handles the static case and needs a second mechanism for the dynamic one.
Parking handles both with one mechanism, and the dynamic case is the one that will matter
in two years.

Three more details worth knowing:

- **Capabilities.** `provides: ['snap-engine']` lets a plugin satisfy a dependency on a
  _capability_ rather than an id. A product that swaps our snapping for its own implements
  the capability, and every dependent plugin is satisfied without knowing anything changed.
- **Version ranges.** `{ id: 'history', range: '^1.0.0' }` is checked at registration against
  the dependency's declared `version`, and throws immediately on a mismatch.
- **Removal is refused when it would strand a dependent.** `remove('snap')` with `edit`
  hard-depending on it throws, naming the dependents. Teardown (`destroyAll`) walks in
  reverse install order, so dependents go before their dependencies.

A failed `setup` disposes that plugin's `DisposableStore` before rethrowing. A stray layer
or listener from a plugin that "isn't installed" is a genuinely baffling thing to debug.

---

## 5. Extension-point catalogue

You want to add X → register a Y.

| You want to…                                        | Register a…             | Through                                 | And you get                                                              |
| --------------------------------------------------- | ----------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| Change the pointer position before any tool sees it | `InteractionMiddleware` | `ctx.interaction.use(fn, { priority })` | Snapping, grid lock, ortho constraint — in **every** tool, forever       |
| Veto or rewrite a mutation before it lands          | `CommitMiddleware`      | `ctx.commit.use(fn, { priority })`      | Validation, attribute defaults, audit stamps, server checks              |
| Add a new kind of snap target                       | `SnapProvider`          | `ctx.tryPlugin('snap')?.addProvider()`  | Your targets appear in every tool that snaps, including future ones      |
| Add a whole new rendering category                  | `LayerTypeDef`          | `ctx.layers.registerType(def)`          | `map.layers.add({ type: 'your-type' })` — deck.gl, heatmap, tile-grid    |
| Add an interactive mode                             | `Tool`                  | `ctx.tools.register(id, tool)`          | Exclusive activation, cursor, post-pipeline events                       |
| Make something undoable                             | `Command`               | `ctx.commands.dispatch(cmd)`            | Cross-plugin undo/redo, transactions, coalescing — free                  |
| Block a write on a domain rule                      | `ValidationRule`        | `ctx.validation.add(rule)`              | Runs last in the commit pipeline; `error` blocks, `warning` annotates    |
| Add a coordinate system                             | `ProjectedCrs` spec     | `ctx.crs.register(spec)`                | Every planar facility (snap, grid, area, topology) works in it unchanged |
| Add UI chrome                                       | `Control`               | `map.plugin('ui').addControl(c, pos)`   | Themed, localised, torn down with the plugin                             |
| Localise anything                                   | `Messages`              | `ctx.i18n.register(locale, messages)`   | Later registration wins, so presets override plugins                     |
| React to something                                  | handler                 | `ctx.events.on(type, fn)`               | —                                                                        |
| Veto something                                      | handler                 | `ctx.events.onBefore('before:…', fn)`   | `preventDefault(reason)`                                                 |

Two rules of thumb hold across all of it.

**If your plugin has to know about another plugin by name, you picked the wrong extension
point.** The draw plugin does not import the snap plugin; snapping rewrote `ctx.lngLat`
before the draw tool ever read it. That indirection _is_ the architecture.

**Everything you register goes into `ctx.disposables`.** The store is disposed for you on
`destroy`, in reverse order. A plugin that registers a listener outside it leaks it forever,
and worse, a re-registered plugin then runs its handler twice. The teardown test exists to
catch exactly this, and it is not optional.

---

## 6. The renderer seam

`Renderer` is deliberately small: mount, project/unproject, sources, layers, camera, hit
testing, pointer/camera events, `setCursor`, `getNative`, `destroy`. Anything that can be
built on top of those primitives — measurement, highlighting, editing handles — is a plugin,
not a renderer method.

`MapLibreRenderer` is the only implementation we ship and the right default. `FakeRenderer`
(in `@fleximap/core/testing`) is the proof that the seam is real rather than aspirational:
it implements the whole contract with deterministic, analytically-invertible
`project`/`unproject`, and the entire test suite runs against it with no GPU. A test can
therefore say "the pointer is 8 pixels from that vertex" and mean it — which is the only
honest way to test a snap tolerance denominated in pixels.

The sanctioned escape hatch, and the only one:

```ts
const maplibre = map.renderer.getNative<maplibregl.Map>()
maplibre.addControl(new maplibregl.NavigationControl())
```

We _want_ people to reach the underlying map; the alternative is that they fork the library
the first time we have not wrapped something. But it is explicit, greppable, and carries a
warning: you are outside the abstraction, and we cannot undo what you do there.
