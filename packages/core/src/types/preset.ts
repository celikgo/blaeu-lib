import type { DeepPartial } from './common.js'
import type { BlaeuMapConfig } from './config.js'
import type { PluginSpec } from './plugin.js'
import type { LayerSpec } from './extensions.js'
import type { ValidationRule } from './validation.js'
import type { Theme } from './theme.js'
import type { Locale, Messages } from './i18n.js'
import type { InteractionMiddleware, CommitMiddleware, MiddlewareOptions } from './pipeline.js'

/**
 * A domain preset: the bundle that turns the kernel into a vertical product.
 *
 * This is the answer to "how is a cadastre system and a game level editor the
 * same library?" — they are the same kernel with different presets. A preset is
 * a **plain data structure**, not a subclass, and that is what makes it
 * composable, inspectable, serialisable, and overridable at every level.
 *
 * The distinction that keeps the architecture honest:
 *
 *   A **plugin** adds a *capability* — snapping exists, drawing exists. It is
 *   domain-agnostic; the snap plugin has never heard of a parcel.
 *
 *   A **preset** adds *judgement* — snap tolerance is 12 px because that's what
 *   surveyors expect at cadastral scale; overlaps are errors but gaps are only
 *   warnings, because a sliver is usually a digitisation artefact while an
 *   overlap is usually a dispute.
 *
 * If you find an `if (domain === 'cadastre')` inside a plugin, judgement has
 * leaked into the wrong layer.
 */
export interface Preset {
  readonly id: string
  readonly description?: string

  /** Installed in order. Later presets may retune an earlier one's options by id. */
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

/** A preset factory. Every knob a domain expert would touch belongs in `TOptions`. */
export type PresetFactory<TOptions = void> = (options?: TOptions) => Preset
