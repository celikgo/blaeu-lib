import type {
  CrsConfig,
  FlexiMapConfig,
  FlexiMapOptions,
  InteractionConfig,
  ResolvedConfig,
} from './types/config.js'
import type { Camera } from './types/renderer.js'
import type { Locale } from './types/i18n.js'
import type { Preset } from './types/preset.js'
import { createConsoleLogger } from './utils/logger.js'

/**
 * Web Mercator, because it is the only projection that is correct *everywhere* and
 * wrong *nowhere in particular* — a sane default for a library that does not yet
 * know which country it is in. Every domain preset overrides it (a Turkish cadastre
 * wants TUREF/TM30, EPSG:5254) and should: metric truth at cadastral scale comes
 * from a local zone, not from Mercator.
 */
export const DEFAULT_CRS: CrsConfig = Object.freeze({
  working: 'EPSG:3857',
  display: 'decimal',
  precision: 3,
})

export const DEFAULT_INTERACTION: InteractionConfig = Object.freeze({
  doubleClickZoom: true,
  dragPan: true,
  scrollZoom: true,
  keyboard: true,
  /**
   * Three pixels. Below that, a "click" on a trackpad or a touchscreen is
   * indistinguishable from a one-pixel drag, and a draw tool would refuse to place
   * vertices for users whose hands are not perfectly still.
   */
  dragThreshold: 3,
})

export const DEFAULT_CAMERA: Camera = Object.freeze({
  center: Object.freeze([0, 0]) as Camera['center'],
  zoom: 2,
  bearing: 0,
  pitch: 0,
})

export const DEFAULT_LOCALE: Locale = 'en'

/**
 * Fold defaults, the preset's config, and the host app's options into the one
 * fully-resolved object the kernel reads.
 *
 * Precedence, lowest to highest: **defaults → preset → options**. The last of those
 * is the reason a municipality can adopt a national cadastre preset and still bump
 * the coordinate precision to four decimals without forking it.
 *
 * The merge is per-field rather than a generic recursive walk over `unknown`.
 * `ResolvedConfig` is a closed shape, and spelling it out means `exactOptionalPropertyTypes`
 * checks every branch — whereas a generic `deepMerge<T>(a, b)` inevitably needs an
 * `any` somewhere in the middle, and the one field it silently drops is the one you
 * find out about in production. It also sidesteps prototype pollution: nothing here
 * copies an attacker-controlled key onto an object.
 */
export function resolveConfig(options: FlexiMapOptions, preset?: Preset): ResolvedConfig {
  const fromPreset: FlexiMapConfig | undefined = preset?.config

  // Resolved first because the default logger depends on it.
  const strict = coalesce(options.strict, fromPreset?.strict, !isProduction())

  return {
    crs: {
      working: coalesce(options.crs?.working, fromPreset?.crs?.working, DEFAULT_CRS.working),
      display: coalesce(options.crs?.display, fromPreset?.crs?.display, DEFAULT_CRS.display),
      precision: coalesce(
        options.crs?.precision,
        fromPreset?.crs?.precision,
        DEFAULT_CRS.precision,
      ),
    },
    interaction: {
      doubleClickZoom: coalesce(
        options.interaction?.doubleClickZoom,
        fromPreset?.interaction?.doubleClickZoom,
        DEFAULT_INTERACTION.doubleClickZoom,
      ),
      dragPan: coalesce(
        options.interaction?.dragPan,
        fromPreset?.interaction?.dragPan,
        DEFAULT_INTERACTION.dragPan,
      ),
      scrollZoom: coalesce(
        options.interaction?.scrollZoom,
        fromPreset?.interaction?.scrollZoom,
        DEFAULT_INTERACTION.scrollZoom,
      ),
      keyboard: coalesce(
        options.interaction?.keyboard,
        fromPreset?.interaction?.keyboard,
        DEFAULT_INTERACTION.keyboard,
      ),
      dragThreshold: coalesce(
        options.interaction?.dragThreshold,
        fromPreset?.interaction?.dragThreshold,
        DEFAULT_INTERACTION.dragThreshold,
      ),
    },
    // `Preset.locale` sits at the preset's top level, not inside `Preset.config` —
    // presets declare their language next to their message bundles. It is still a
    // preset-level opinion, so it ranks below `config.locale` (the more specific of
    // the two) and below anything the host app passed.
    locale: coalesce(options.locale, fromPreset?.locale, preset?.locale, DEFAULT_LOCALE),
    camera: {
      // Tuples replace wholesale; there is no such thing as half a coordinate.
      center: coalesce(options.camera?.center, fromPreset?.camera?.center, DEFAULT_CAMERA.center),
      zoom: coalesce(options.camera?.zoom, fromPreset?.camera?.zoom, DEFAULT_CAMERA.zoom),
      bearing: coalesce(
        options.camera?.bearing,
        fromPreset?.camera?.bearing,
        DEFAULT_CAMERA.bearing,
      ),
      pitch: coalesce(options.camera?.pitch, fromPreset?.camera?.pitch, DEFAULT_CAMERA.pitch),
    },
    // Replaced wholesale, never merged. A logger assembled from two objects' halves
    // — `debug` from the host app, `error` from ours — routes half the diagnostics
    // into a telemetry pipeline and half into a console nobody is watching.
    logger: options.logger ?? fromPreset?.logger ?? createConsoleLogger({ debug: strict }),
    strict,
  }
}

/**
 * First defined value wins; the last argument is the mandatory floor.
 *
 * The tuple type is what makes this safe: TypeScript will not let you call it
 * without a non-optional final element, so it cannot return `undefined` and
 * `ResolvedConfig` cannot end up with a hole in it.
 */
function coalesce<T>(...values: [...(T | undefined)[], T]): T {
  for (const value of values) {
    if (value !== undefined) return value
  }
  /* c8 ignore next 2 -- unreachable: the final element is non-optional by type. */
  throw new Error('[fleximap] coalesce() reached its end. This is a bug in FlexiMap, not in you.')
}

/**
 * `strict` defaults to on everywhere except a production build.
 *
 * Written as a `typeof` guard around a literal `process.env['NODE_ENV']` so that
 * bundlers can still statically substitute it and drop the dead branch. Reaching it
 * through `globalThis.process` would be tidier and would defeat exactly that — and
 * in a browser bundle with no substitution it evaluates to "not production", which
 * is the safe direction to be wrong in.
 */
function isProduction(): boolean {
  return typeof process !== 'undefined' && process.env['NODE_ENV'] === 'production'
}
