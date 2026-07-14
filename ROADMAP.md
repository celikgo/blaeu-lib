# Roadmap

What is next, in the order we intend to do it, with the reason for the order. Items near the
top are ones the architecture is already shaped for; items near the bottom are ones that will
need an ADR before a line is written.

Nothing here is a promise of a date. It is a statement of intent and of sequence, which is
the more useful thing to publish.

## Before anything else: close the two edges we already know about

**Browser-mode tests for `MapLibreRenderer`.** The suite (500+ tests) runs against
`FakeRenderer`, which proves the renderer seam is real but leaves exactly one surface
unverified: our translation of `LayerStyle` into MapLibre paint/layout, and our normalisation
of its pointer events. A Vitest browser-mode run against a real WebGL context, asserting that
we call MapLibre correctly — not asserting on MapLibre's internal source JSON, which would be
testing MapLibre — is the highest-value test we have not written. It is first because
everything below it makes the renderer seam matter more.

**A commit path that owns its own pipeline run.** `Command.execute()` is synchronous and the
commit pipeline is async, so `commands.dispatch()` does not run the pipeline; a write that
must be validated runs `await map.commit.run(ctx)` first and dispatches only if it survived
(see ADR 0004). That works and is honest, but it is a footgun for anyone who assumes
`dispatch()` validates. The likely shape is an explicit `dispatchAsync()` that owns the run.
It is a contract change, so it gets an ADR.

## v2

### 3D and terrain — a Three.js renderer through the existing seam

`Renderer` is already the seam, `Camera` already carries `pitch`, and `FakeRenderer` already
proves a second implementation is possible. A Three.js renderer is therefore a **new package**
rather than a fork — which is the payoff of ADR 0008 being cashed.

The honest scope: terrain and extruded geometry (a zoning plan with height caps is a 3D object
and planners already think of it that way) come first; true 3D _editing_ — dragging a vertex
in three dimensions with a snap engine that understands planes — is a much larger problem and
is not in this bullet.

### Real-time collaboration — the command bus is already the CRDT seam

This is the item that most looks like luck and is not.

A collaboration layer needs a stream of operations that are (a) typed, (b) reversible, (c)
serialisable, and (d) semantically meaningful rather than positional diffs. `Command` is all
four, and it is all four because **undo** needed it to be — a command that can restore deep
equality has, by construction, captured enough to be replayed on another machine, and a
command bus that already broadcasts every mutation to a subscriber (history) can broadcast it
to a transport instead.

So collaboration is not a new mechanism. It is a second subscriber to `onDidExecute`, plus a
history plugin that respects remote authorship (you may not undo my edit), plus a conflict
policy. The kernel does not change. That is what good seams buy you, and it is why ADR 0002
argued for history-as-subscriber rather than history-in-the-core.

The genuinely hard parts, which no amount of good design removes: concurrent edits to a
_shared vertex_ (topological editing means one corner belongs to two parcels and possibly two
editors), and the fact that a cadastral system has an authority — a merge that is
mathematically clean can still be legally wrong. Expect this to ship first as
last-writer-wins-with-locking on a collection, and only later as a real CRDT.

### Touch-first mobile editing

Field surveyors use tablets. Today the interaction model already helps more than it looks:
tools receive a normalised `InteractionContext`, never a DOM event, so a tool written for a
mouse already runs under touch, and the default handle size is 10 px — a fingertip — for
exactly this reason.

What is missing is the part that cannot be abstracted away: a long-press vertex grab, a
two-finger rotate that does not fight the map's own gesture handling, a snap indicator sized
for a finger that is _covering_ the corner it is snapping to, and a UI that assumes one hand.
That is design work more than architecture work, and it is high on the list because it is the
difference between a tool a surveyor uses in the office and one they use in the field.

### A React binding package (`@fleximap/react`)

`@fleximap/plugin-ui` is framework-free DOM on purpose, and it should stay that way — but the
host app is usually React, and the current story ("useEffect, create the map, remember to
destroy it") is boilerplate we should own.

The shape falls out of the existing API rather than fighting it: every subscription returns a
`Disposable`, which is precisely an effect cleanup; `ListenerOptions.signal` already takes an
`AbortSignal`; `map.plugin('draw')` is already typed, so a `usePlugin('draw')` hook is typed
with no extra machinery. `<FlexiMap preset={cadastrePreset()}>` plus `useFlexiMap()`,
`usePlugin()`, `useSelection()`, `useHistory()`. Nothing in the kernel changes.

### Offline / PWA tile caching

A field surveyor in a village outside Konya has no connectivity, and a cadastral tool that
requires a network is a cadastral tool that stays in the office. Tile caching in a service
worker, plus a store that can be seeded from and flushed to IndexedDB, plus a command log that
survives a reload and replays on reconnect — the last of which is, again, the command bus
being the right seam.

### deck.gl layer types

`LayerTypeDef` is the extension point and it already works: `preset-game` registers a
`tile-grid` layer type in one file, and the core has never heard of it. A deck.gl plugin
registering `type: 'deckgl'` — scatterplot, hexbin, arc, trip — is the same move, and gives
FlexiMap large-scale analytical visualisation without a line of it entering the kernel.

### WASM GEOS for heavy topology

JSTS is correct (ADR 0007) and fast enough for interactive work on a few hundred neighbours.
It is not fast enough for validating a 100 000-parcel batch import, and it does not need to
be — that is a different workload. WASM GEOS is the same C++ engine PostGIS uses, with the
same precision model, and it belongs behind the same plugin API.

This is deliberately _optional_: the WASM blob is a large thing to ship to a browser that may
only ever draw one polygon. Because topology is a plugin and the engine is an implementation
detail of that plugin, swapping it is a plugin-internal change and not a contract change. ADR
0007 is what makes this cheap.

### AI-assisted digitisation

The largest single win available to a cadastre product, and the one worth being most careful
about.

Tracing a parcel boundary from an orthophoto is the bulk of a digitiser's day, and it is the
kind of edge detection that a segmentation model is genuinely good at. The shape of the
feature is clear: the model proposes a ring; it enters as a **normal `Command`**, so it is
undoable like anything else; it goes through the **commit pipeline**, so the same topology
rules that judge a hand-drawn parcel judge this one; and it snaps to the neighbours' existing
corners through the **snap providers**, because a traced boundary that does not share the
neighbour's corner has manufactured a sliver.

Every one of those three is an existing seam. The AI does not get a privileged path into the
store, and that is not a technicality — it is the whole safety argument. A model that could
write geometry directly would be a model that could write geometry no rule had judged.

The product constraint, which is not negotiable: the software **proposes**, the surveyor
**accepts**. Auto-tracing that commits without review is the same mistake as `autoFix: true`,
and it loses the trust of the people whose job it is to be exactly right — permanently,
because once a surveyor has found one boundary they did not draw, they must re-check every
boundary they did not draw.

### Headless / SSR export

A `Renderer` with no GPU — enough to produce a PNG or a PDF of a parcel plan on a server, from
the same store, the same theme and the same layer definitions the browser uses. Falls out of
ADR 0008. Mostly a matter of drawing `LayerStyle` onto a canvas.

### A plugin registry

A published index of community plugins, with the version and capability metadata the
`PluginManager` already understands (`dependencies`, `range`, `provides`). Worth stating why
this is last and not first: it is the item that most depends on everything above it being
stable, and the deferred-install "parking" mechanism (ARCHITECTURE §4) was designed with it in
mind — a marketplace installs plugins at runtime, in an order nobody chose, which is exactly
the case a topological sort cannot handle and parking can.

## Explicitly not planned

- **A basemap or tile service.** Bring your own MapLibre style.
- **A full GIS.** No raster reprojection, no geoprocessing suite, no cross-dataset attribute
  joins. FlexiMap is an editing kernel, and the boundary is deliberate.
- **A visual plugin builder.** Plugins are forty lines of TypeScript. That is already the
  simplification.
