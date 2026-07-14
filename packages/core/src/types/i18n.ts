import type { Disposable } from './common.js'

/** BCP-47. `'tr'` and `'en'` ship with the library. */
export type Locale = string

/** Flat, dotted keys: `'draw.polygon.hint'`. Flat because nested message trees are a merge nightmare. */
export type Messages = Record<string, string>

/**
 * Localisation.
 *
 * Plugins ship their own message bundles and register them; presets override
 * them. That layering is what lets the cadastre preset rename the generic
 * "Polygon" tool to "Parsel çiz" without the draw plugin containing a word of
 * Turkish or knowing that cadastre exists.
 *
 * Turkish is a first-class target here, and it exposes a real bug class: the
 * dotless ı. `'PARSEL'.toLowerCase()` is `'parsel'` in English locale but the
 * Turkish uppercase of `i` is `İ`, and `I` lowercases to `ı`. Any code doing
 * case-insensitive comparison on user-entered attribute values **must** pass a
 * locale (`toLocaleLowerCase('tr')`) or it will mismatch on words containing i/I.
 * This has broken search in more Turkish applications than any other single
 * thing.
 */
export interface I18n {
  readonly locale: Locale
  setLocale(locale: Locale): void

  /**
   * Translate. Falls back: requested locale → `'en'` → the key itself.
   *
   * Returning the key rather than throwing is deliberate: a missing translation
   * should render as ugly text in a corner of the UI, not take down the map.
   */
  t(key: string, params?: Record<string, unknown>): string

  /** Merge a message bundle. Later registrations win, which is how presets override plugins. */
  register(locale: Locale, messages: Messages): Disposable

  /** Locale-aware number formatting — Turkish uses `.` for thousands and `,` for decimals. */
  number(value: number, options?: Intl.NumberFormatOptions): string

  /** Area with the right unit and separators: `1.234,56 m²`. */
  area(squareMetres: number): string

  onChange(handler: (locale: Locale) => void): Disposable
}
