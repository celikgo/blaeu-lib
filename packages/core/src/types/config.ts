import type { DeepPartial, Logger } from './common.js'
import type { Camera } from './renderer.js'
import type { CrsCode } from './crs.js'
import type { Locale } from './i18n.js'
import type { Renderer } from './renderer.js'
import type { Preset } from './preset.js'
import type { PluginSpec } from './plugin.js'
import type { LayerSpec } from './extensions.js'
import type { Theme } from './theme.js'

export interface CrsConfig {
  /** The plane for all precise geometry, readouts and exports. Default `EPSG:3857`. */
  readonly working: CrsCode
  /** How coordinates are shown to the user. */
  readonly display: 'projected' | 'decimal' | 'dms'
  /** Decimal places in the working CRS's unit. `3` = millimetres. */
  readonly precision: number
}

export interface InteractionConfig {
  readonly doubleClickZoom: boolean
  readonly dragPan: boolean
  readonly scrollZoom: boolean
  readonly keyboard: boolean
  /** Pixels the pointer may move before a press becomes a drag. */
  readonly dragThreshold: number
}

/** The fully-resolved config. Every field present — no optionals to guard against. */
export interface ResolvedConfig {
  readonly crs: CrsConfig
  readonly interaction: InteractionConfig
  readonly locale: Locale
  readonly camera: Camera
  readonly logger: Logger
  /** Freezes store reads and asserts invariants. Defaults to on outside production. */
  readonly strict: boolean
}

/** What a user writes. Everything optional; sensible defaults fill the rest. */
export type BlaeuMapConfig = DeepPartial<Omit<ResolvedConfig, 'logger'>> & {
  readonly logger?: Logger
}

/** What `createBlaeuMap` takes. */
export interface BlaeuMapOptions extends BlaeuMapConfig {
  readonly container: HTMLElement | string

  /**
   * A domain preset — the usual way to build a product.
   *
   * ```ts
   * const map = await createBlaeuMap({
   *   container: '#map',
   *   preset: cadastrePreset({ crs: 'EPSG:5254', locale: 'tr' }),
   * })
   * ```
   *
   * Anything set alongside the preset overrides it, so a host app can tweak a
   * preset without composing a new one.
   */
  readonly preset?: Preset

  /** Extra plugins, installed after the preset's. */
  readonly plugins?: readonly PluginSpec[]

  readonly layers?: readonly LayerSpec[]
  readonly theme?: Theme | DeepPartial<Theme>

  /**
   * Swap the rendering engine.
   *
   * Defaults to MapLibre. `@blaeu/core/testing` passes a `FakeRenderer` here,
   * which is how the whole suite runs headless — and the proof that the seam is
   * real rather than aspirational.
   */
  readonly renderer?: Renderer
}
