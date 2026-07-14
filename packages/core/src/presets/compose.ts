import type { FlexiPlugin, PluginSpec } from '../types/plugin.js'
import type { Preset } from '../types/preset.js'

/* ========================================================================= */
/* Plugin specs                                                              */
/* ========================================================================= */

/** The tuple half of {@link PluginSpec}, named so it can be type-guarded. */
type PluginTuple = readonly [
  factory: (options?: never) => FlexiPlugin<unknown, never>,
  options?: unknown,
]

/** A plugin factory, with the `never` options erased so we can actually call it. */
type PluginFactory = (options?: unknown) => FlexiPlugin<unknown, unknown>

function isTuple(spec: PluginSpec): spec is PluginTuple {
  // `Array.isArray` narrows to `any[]`, which does not discriminate a *readonly*
  // tuple out of the union. Wrapping it in a predicate is the only way to get the
  // narrowing we actually want without a cast at every call site.
  return Array.isArray(spec)
}

/**
 * Resolve a {@link PluginSpec} into the plugin instance and the options it was
 * declared with. The one place in the codebase that invokes a plugin factory.
 *
 * `FlexiMap` calls this for every spec a preset or a user hands it, and passes
 * `options` straight to `PluginManager.use()`. Note that the options go to *both*
 * places: into the factory (so a plugin that closes over its options keeps
 * working) and into `ctx.options` (so a plugin that reads them from the context
 * does too). Feeding only one of the two would silently half-configure every
 * plugin written in the other style.
 */
export function normalisePluginSpec(spec: PluginSpec): {
  plugin: FlexiPlugin<unknown, unknown>
  options: unknown
} {
  if (!isTuple(spec)) {
    // The object form carries no options — `ctx.options` is whatever the plugin's
    // own defaults made it.
    return { plugin: spec as FlexiPlugin<unknown, unknown>, options: undefined }
  }

  const [factory, options] = spec
  return { plugin: invokeFactory(factory as unknown as PluginFactory, options), options }
}

function invokeFactory(factory: PluginFactory, options: unknown): FlexiPlugin<unknown, unknown> {
  let plugin: FlexiPlugin<unknown, unknown>
  try {
    plugin = factory(options)
  } catch (err) {
    throw new Error(
      `[fleximap] a plugin factory threw while being installed: ${err instanceof Error ? err.message : String(err)}. ` +
        `A plugin factory must be pure — build the plugin object and return it; do not touch a map, the DOM, or a global.`,
      { cause: err },
    )
  }
  if (typeof plugin?.id !== 'string' || plugin.id.length === 0) {
    throw new Error(
      `[fleximap] a plugin factory returned something without a string "id". ` +
        `Every plugin needs a unique, stable, kebab-case id — it is the key in FlexiPluginRegistry.`,
    )
  }
  return plugin
}

/**
 * The id a spec will install under.
 *
 * For the object form that is simply `.id`. For the tuple form the plugin does
 * not exist yet, so we **invoke the factory once, with no arguments, purely to
 * read its id**. That is safe because preset authoring mandates that factories are
 * pure (see the `fleximap-preset-authoring` skill): calling one must construct a
 * plain object and nothing else. The throwaway instance is discarded; the tuple
 * stays un-invoked in the composed preset so that the *final*, merged options
 * still reach the factory at install time.
 *
 * Cached per factory, because composing three presets that all mention the snap
 * plugin should not construct it three times.
 */
const factoryIds = new WeakMap<object, string>()

function pluginIdOf(spec: PluginSpec): string {
  if (!isTuple(spec)) {
    const id = (spec as FlexiPlugin<unknown, unknown>).id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `[fleximap] a preset lists a plugin with no "id". ` +
          `Either the object is not a plugin, or you meant the tuple form: [myPlugin, { …options }].`,
      )
    }
    return id
  }

  const factory = spec[0] as unknown as PluginFactory
  const cached = factoryIds.get(factory)
  if (cached !== undefined) return cached

  let id: string
  try {
    id = invokeFactory(factory, undefined).id
  } catch (err) {
    throw new Error(
      `[fleximap] could not read the id of a plugin factory: ${err instanceof Error ? err.message : String(err)}. ` +
        `Preset composition invokes each factory once, with no arguments, to find out which plugin it is — so a factory must ` +
        `have a default for every option (e.g. \`function snapPlugin(opts: SnapOptions = {}) { … }\`).`,
      { cause: err },
    )
  }
  factoryIds.set(factory, id)
  return id
}

/* ========================================================================= */
/* Merge primitives                                                          */
/* ========================================================================= */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Deep merge, later wins.
 *
 * Arrays *replace* rather than concatenate. That asymmetry with the preset's own
 * append-semantics is deliberate: an array inside `config` (a dasharray, a padding
 * tuple) is one indivisible value, and concatenating two of them produces garbage
 * that renders rather than an error that tells you.
 */
function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(override)) return override

  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    // An explicit `undefined` must not blank out a base value — `{ tolerance: undefined }`
    // is what you get from an unset optional field, not a request to delete.
    if (value === undefined) continue
    out[key] = key in out ? deepMerge(out[key], value) : value
  }
  return out
}

function concat<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): readonly T[] {
  if (!a) return b ?? []
  if (!b) return a
  return [...a, ...b]
}

/* ========================================================================= */
/* definePreset                                                              */
/* ========================================================================= */

const PRESET_KEYS = new Set<keyof Preset>([
  'id',
  'description',
  'plugins',
  'config',
  'layers',
  'validation',
  'theme',
  'i18n',
  'locale',
  'interactionMiddleware',
  'commitMiddleware',
])

/**
 * Identity, plus the cheap checks that turn a silent typo into an error.
 *
 * A preset is plain data, so nothing stops you writing `validations: [...]` (with
 * an `s`) and watching every rule you wrote quietly not run. TypeScript catches
 * that for an object literal, and nothing catches it for a preset assembled at
 * runtime from JSON, from a spread, or by a preset factory whose return type got
 * widened. This does.
 */
export function definePreset(preset: Preset): Preset {
  if (typeof preset.id !== 'string' || preset.id.length === 0) {
    throw new Error(
      '[fleximap] a preset needs a non-empty string "id". Add one, e.g. { id: "cadastre" }.',
    )
  }

  const unknownKeys = Object.keys(preset).filter((k) => !PRESET_KEYS.has(k as keyof Preset))
  if (unknownKeys.length > 0) {
    throw new Error(
      `[fleximap] preset "${preset.id}" has unknown field(s): ${unknownKeys.join(', ')}. ` +
        `Valid fields: ${[...PRESET_KEYS].join(', ')}. (A misspelled field is silently ignored at runtime, which is why this throws.)`,
    )
  }

  assertUnique(
    preset.plugins?.map(pluginIdOf),
    (id) =>
      `[fleximap] preset "${preset.id}" lists plugin "${id}" twice. ` +
      `Installing it twice would register its listeners and layers twice, and every action would happen twice. ` +
      `Merge the two entries into one, or drop the duplicate.`,
  )

  assertUnique(
    preset.layers?.map((l) => l.id),
    (id) =>
      `[fleximap] preset "${preset.id}" declares layer "${id}" twice. Layer ids must be unique.`,
  )

  assertUnique(
    preset.validation?.map((r) => r.id),
    (id) =>
      `[fleximap] preset "${preset.id}" declares validation rule "${id}" twice. ` +
      `Rule ids are the key the registry removes by, so a duplicate makes one of the two unremovable.`,
  )

  return preset
}

function assertUnique(ids: readonly string[] | undefined, message: (id: string) => string): void {
  if (!ids) return
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new Error(message(id))
    seen.add(id)
  }
}

/* ========================================================================= */
/* composePresets                                                            */
/* ========================================================================= */

/** A plugin entry mid-merge: the implementation, plus the options accumulated for it. */
interface PluginEntry {
  readonly id: string
  /** Present for the object form. */
  plugin: FlexiPlugin<unknown, never> | undefined
  /** Present for the tuple form. */
  factory: PluginTuple[0] | undefined
  options: unknown
}

/**
 * Compose presets. **Later wins**, and this is how a municipality customises a
 * national preset without forking it.
 *
 * The merge semantics, which are the whole contract of the preset system:
 *
 * | field | rule |
 * |---|---|
 * | `config`, `theme` | deep merge |
 * | `plugins` | append — but a repeated plugin id **deep-merges its options into the existing entry, in place** |
 * | `validation`, `layers`, `interactionMiddleware`, `commitMiddleware` | append |
 * | `i18n` | merge per locale, later wins per key |
 * | `id`, `description`, `locale` | later wins |
 *
 * The plugin rule is the subtle one, and it is the reason presets compose at all:
 *
 * ```ts
 * composePresets(
 *   cadastrePreset(),                                  // [snapPlugin, { tolerance: 12, providers: [...] }]
 *   definePreset({ id: 'izmir', plugins: [[snapPlugin, { tolerance: 8 }]] }),
 * )
 * // → [snapPlugin, { tolerance: 8, providers: [...] }]   — retuned, not re-declared
 * ```
 *
 * *In place* matters: the retuned entry keeps the base's install position, so a
 * plugin that depends on snap still finds it where the base preset put it. If a
 * later preset supplies a genuinely different implementation for the same id
 * (their snap engine, not ours) that implementation wins — but its options are
 * still merged over the base's, because the base's judgement about tolerance is
 * exactly the thing worth keeping.
 */
export function composePresets(...presets: readonly Preset[]): Preset {
  const first = presets[0]
  if (!first) {
    throw new Error(
      '[fleximap] composePresets() needs at least one preset. Pass the base preset first.',
    )
  }
  if (presets.length === 1) return first

  // Insertion-ordered: this Map *is* the plugin install order.
  const plugins = new Map<string, PluginEntry>()
  const i18n: Record<string, Record<string, string>> = {}

  let id = first.id
  let description: string | undefined
  let locale: string | undefined
  let config: Preset['config']
  let theme: Preset['theme']
  let layers: Preset['layers'] = []
  let validation: Preset['validation'] = []
  let interactionMiddleware: Preset['interactionMiddleware'] = []
  let commitMiddleware: Preset['commitMiddleware'] = []

  for (const preset of presets) {
    id = preset.id
    if (preset.description !== undefined) description = preset.description
    if (preset.locale !== undefined) locale = preset.locale

    config = deepMerge(config, preset.config) as Preset['config']
    theme = deepMerge(theme, preset.theme) as Preset['theme']

    layers = concat(layers, preset.layers)
    validation = concat(validation, preset.validation)
    interactionMiddleware = concat(interactionMiddleware, preset.interactionMiddleware)
    commitMiddleware = concat(commitMiddleware, preset.commitMiddleware)

    for (const [messageLocale, messages] of Object.entries(preset.i18n ?? {})) {
      i18n[messageLocale] = { ...i18n[messageLocale], ...messages }
    }

    for (const spec of preset.plugins ?? []) {
      mergePluginSpec(plugins, spec)
    }
  }

  const composed: Preset = {
    id,
    ...(description !== undefined ? { description } : {}),
    ...(plugins.size > 0 ? { plugins: [...plugins.values()].map(toSpec) } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(layers.length > 0 ? { layers } : {}),
    ...(validation.length > 0 ? { validation } : {}),
    ...(Object.keys(i18n).length > 0 ? { i18n } : {}),
    ...(locale !== undefined ? { locale } : {}),
    ...(interactionMiddleware.length > 0 ? { interactionMiddleware } : {}),
    ...(commitMiddleware.length > 0 ? { commitMiddleware } : {}),
  }

  return definePreset(composed)
}

function mergePluginSpec(plugins: Map<string, PluginEntry>, spec: PluginSpec): void {
  const specId = pluginIdOf(spec)
  const incoming: PluginEntry = isTuple(spec)
    ? { id: specId, plugin: undefined, factory: spec[0], options: spec[1] }
    : {
        id: specId,
        plugin: spec as FlexiPlugin<unknown, never>,
        factory: undefined,
        options: undefined,
      }

  const existing = plugins.get(specId)
  if (!existing) {
    plugins.set(specId, incoming)
    return
  }

  // Same id, second mention: keep the *position* (Map.set on an existing key does
  // not reorder), take the later implementation, and deep-merge the later options
  // over the earlier ones. This is what lets `[snapPlugin, { tolerance: 8 }]` retune
  // a base preset's snap plugin without re-stating its provider list.
  existing.options = deepMerge(existing.options, incoming.options)
  if (incoming.factory) {
    existing.factory = incoming.factory
    existing.plugin = undefined
  } else if (incoming.plugin) {
    existing.plugin = incoming.plugin
    existing.factory = undefined
  }
}

function toSpec(entry: PluginEntry): PluginSpec {
  if (entry.factory) return [entry.factory, entry.options] as PluginSpec
  const plugin = entry.plugin
  /* c8 ignore next 3 -- unreachable: an entry always has a factory or a plugin */
  if (!plugin) {
    throw new Error(
      `[fleximap] internal: plugin entry "${entry.id}" has neither a factory nor an instance.`,
    )
  }
  // An already-constructed plugin object that a later preset attached options to.
  // The object form carries no options slot, so wrap it in a factory that ignores
  // its argument: the options can no longer reach the plugin's closure (it was
  // built before we saw them), but they still reach `ctx.options`, which is where
  // a plugin written for composition reads them from anyway.
  if (entry.options !== undefined) {
    return [() => plugin, entry.options] as PluginSpec
  }
  return plugin
}

/* ========================================================================= */
/* overridePreset                                                            */
/* ========================================================================= */

/**
 * Replace, rather than merge.
 *
 * `composePresets` appends — which is right almost always, because a downstream
 * product usually wants the national preset's rules *plus* its own. Occasionally it
 * genuinely needs to throw the base's rules away (a demo environment that must not
 * enforce minimum parcel area, say), and appending cannot express that.
 *
 * ```ts
 * overridePreset(cadastrePreset(), { validation: [] })   // no rules at all
 * ```
 *
 * Needing this often is a smell that the base preset was too opinionated — the
 * knob should have been an option on the preset factory instead.
 */
export function overridePreset(base: Preset, overrides: Partial<Preset>): Preset {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    // Only keys actually *present* replace. `{ theme: undefined }` — which is what
    // an unset optional field spreads to — must not erase the base's theme.
    if (value === undefined) continue
    out[key] = value
  }
  return definePreset(out as unknown as Preset)
}
