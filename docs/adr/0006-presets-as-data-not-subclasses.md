# ADR 0006 — Presets are data, not subclasses

Status: accepted

## Context

The kernel plus a pile of plugins is not a product. A land registry needs the snap tolerance
to be 12 px, the working CRS to be a TUREF/TM belt, coordinates to read out in millimetres,
topological editing on, overlaps to be errors and gaps to be warnings, the parcel form to
have `ada` and `parsel` fields, and the whole thing in Turkish. That bundle of decisions is
the product. The plugins are just the parts.

So there has to be a layer that carries _judgement_ — and the question is what shape it takes.
The instinctive answer in an object-oriented codebase is a class: `class CadastreMap extends
BlaeuMap`, overriding the defaults. That answer is wrong, and it is worth being precise about
why, because the wrongness only shows up on the second customer.

A municipality wants the national cadastre configuration, but with an 8 px snap tolerance,
one extra validation rule, and one extra layer. With subclassing they write
`class IzmirMap extends CadastreMap`. Then a second municipality wants the national
configuration plus a _utilities_ extension, which is a different subclass. Now someone wants
both. There is no way to have both, because a class has one base, and the two hierarchies do
not merge. The customer forks. Once a customer forks, they never take an upgrade again, and
your bug fix does not reach them.

## Decision

**A preset is a plain data structure returned by a pure function.**

```ts
interface Preset {
  readonly id: string
  readonly description?: string
  readonly plugins?: readonly PluginSpec[]
  readonly config?: BlaeuMapConfig
  readonly layers?: readonly LayerSpec[]
  readonly validation?: readonly ValidationRule[]
  readonly theme?: Theme | DeepPartial<Theme>
  readonly i18n?: Readonly<Record<Locale, Messages>>
  readonly locale?: Locale
  readonly interactionMiddleware?: readonly (readonly [InteractionMiddleware, MiddlewareOptions?])[]
  readonly commitMiddleware?: readonly (readonly [CommitMiddleware, MiddlewareOptions?])[]
}
```

`cadastrePreset(options)` touches no map, no DOM and no global. Call it twice and you get two
equal objects. That is what makes it inspectable, snapshot-testable, serialisable, and — the
point — **composable**:

```ts
const izmir = composePresets(
  cadastrePreset({ crs: 'EPSG:5253' }), // İzmir's belt (TUREF/TM27)
  definePreset({
    id: 'izmir',
    plugins: [[snapPlugin, { tolerance: 8 }]], // retunes; does not re-declare
    validation: [minParcelArea({ severity: 'error', minArea: 250 })],
    config: { crs: { precision: 4 } },
  }),
)
```

Merge semantics, later wins: `config` and `theme` **deep merge**; `plugins`, `validation`,
`layers` and both middleware lists **append**; `i18n` merges per locale; `id`, `description`
and `locale` are replaced.

The subtle rule, and the one that makes composition actually work: **a repeated plugin id
deep-merges its options into the existing entry, in place.** `[snapPlugin, { tolerance: 8 }]`
retunes the base's snap plugin _while keeping its provider list and its install position_,
so anything depending on snap still finds it where the base put it. This is why plugin specs
are stored as an **un-invoked tuple** `[factory, options]` rather than a constructed plugin —
the factory must not run until the final, merged options are known.

`overridePreset(base, { validation: [] })` replaces rather than appends, for the rare case
where a downstream product genuinely must throw the base's rules away.

The division of labour this establishes:

- A **plugin** adds a _capability_ and is domain-agnostic. The snap plugin has never heard of
  a parcel.
- A **preset** adds _judgement_. Snap tolerance is 12 px because a looser one invents slivers.

`preset-urban` installs the same `topologyPlugin` as `preset-cadastre` and sets
`noOverlapWithNeighbours({ severity: 'warning' })` where cadastre sets `'error'`. One inverted
line. In cadastre an overlap is a dispute — two people believe they own the same ground, and
the write must be refused. In planning an overlap is a _thought_ — a planner dragging a
commercial zone across a residential one to see how it looks is doing their job, and a tool
that refuses the intermediate state is a tool that gets closed. The plugin cannot know which
it is looking at. The preset can.

## Alternatives rejected

**Subclassing (`class CadastreMap extends BlaeuMap`).** Rejected on the composition argument
above: it composes exactly once. It also puts judgement behind a `super` call, which is the
hardest kind of configuration to discover — you cannot `console.log` an override chain.

**A config object with no plugin list** — i.e. all plugins always installed, and the preset
only turns knobs. Rejected because it forecloses `preset-game`, which deliberately does _not_
install `plugin-topology` so that the bundle does not carry JSTS. "You do not pay for what
you do not use" requires the preset to control the plugin list.

**Presets as a plugin** (a `cadastrePlugin` that installs other plugins). Attractive — one
concept instead of two. Rejected because a plugin is an object with behaviour and a lifecycle,
and two of them cannot be _merged_. You would be back to needing a composition mechanism, and
it would have to reach inside a plugin's closure to retune its options, which is exactly what
the un-invoked tuple avoids.

**JSON/YAML presets, loaded at runtime.** Genuinely appealing for a plugin marketplace, and
mostly achievable — a preset is already plain data. Rejected _for now_ because
`ValidationRule.check` and `InteractionMiddleware` are functions, and serialising them means
inventing a rule DSL. The door is open: everything except the function-valued fields already
round-trips through JSON.

## Consequences

- **Good.** A municipality retunes a national preset with `composePresets` and keeps taking
  upstream fixes. Nobody forks.
- **Good.** A preset is testable without a map. `expect(cadastrePreset().commitMiddleware).toHaveLength(1)`
  is a real test in this repo, and it runs in microseconds.
- **Good.** `definePreset()` validates its input — unknown fields throw, duplicate plugin ids
  throw, duplicate layer and rule ids throw. A misspelled `validations:` is silently ignored
  at runtime by a plain object; this turns it into an error at construction.
- **Bad.** The merge semantics are a contract users have to learn, and the deep-merge /
  append asymmetry is arbitrary-looking until you hit the case it was designed for. It is
  documented in the README table and in `composePresets`' own doc comment, and that is the
  best we can do.
- **Bad.** Preset option surfaces grow. `CadastreOptions` has twenty-odd fields, because the
  rule is "if a user would have to copy the preset file to change a number, it should have
  been an option." That is the right rule and it produces a long interface.
- **Bad.** Composing three presets that all mention the snap plugin invokes its factory once
  per mention just to read its `id` (cached in a `WeakMap`). That is only safe because preset
  authoring _mandates_ that factories are pure. A factory with a side effect breaks
  composition in a way that is genuinely hard to diagnose.
