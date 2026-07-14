import type { Disposable } from '../types/common.js'
import type { I18n, Locale, Messages } from '../types/i18n.js'
import { en } from './messages/en.js'
import { tr } from './messages/tr.js'

/** The last stop in the fallback chain. A key missing here is a key the user sees raw. */
const FALLBACK: Locale = 'en'

const PLACEHOLDER = /\{(\w+)\}/g

/**
 * Localisation, layered.
 *
 * The mechanism worth understanding is `register()`. Bundles are kept as an
 * ordered **stack per locale**, not merged into one map, and lookup walks the
 * stack from the top down. Two consequences fall straight out of that:
 *
 * - A preset registered after a plugin shadows the plugin's strings, so the
 *   cadastre preset can rename "Polygon" to "Parsel çiz" without the draw plugin
 *   containing a word of Turkish or knowing that cadastre exists.
 * - Disposing a registration removes *that layer*, which means any key it shadowed
 *   simply becomes visible again. A merge-and-restore implementation has to
 *   remember what it overwrote and put it back, and it gets that wrong the first
 *   time three bundles overlap on one key.
 */
export class FlexiI18n implements I18n {
  #locale: Locale
  /** locale → registration stack, oldest first. The top of the stack wins. */
  readonly #stacks = new Map<Locale, Messages[]>()
  /** locale → flattened view of its stack. Invalidated on every register/dispose. */
  readonly #flat = new Map<Locale, Messages>()
  readonly #formatters = new Map<string, Intl.NumberFormat>()
  #handlers: ((locale: Locale) => void)[] = []
  #chain: Locale[]

  constructor(locale: Locale) {
    this.#locale = locale
    this.#chain = fallbackChain(locale)

    // Core's own bundles go in first, so that *everything* registered later —
    // plugin, preset, host app — can override them.
    this.register('en', en)
    this.register('tr', tr)
  }

  get locale(): Locale {
    return this.#locale
  }

  setLocale(locale: Locale): void {
    if (locale === this.#locale) return
    this.#locale = locale
    this.#chain = fallbackChain(locale)

    for (const handler of [...this.#handlers]) {
      try {
        handler(locale)
      } catch (err) {
        // A plugin failing to relabel its toolbar must not leave the rest of the UI
        // stuck in the old language.
        console.error('[fleximap] locale change handler threw:', err)
      }
    }
  }

  t(key: string, params?: Record<string, unknown>): string {
    let message: string | undefined
    for (const locale of this.#chain) {
      message = this.#messages(locale)[key]
      if (message !== undefined) break
    }
    // The key itself, never a throw. A missing translation should be ugly text in
    // the corner of a toolbar, not a dead map — and the raw key tells whoever sees
    // it exactly which string to add.
    if (message === undefined) return key
    return params === undefined ? message : interpolate(message, params)
  }

  register(locale: Locale, messages: Messages): Disposable {
    let stack = this.#stacks.get(locale)
    if (!stack) {
      stack = []
      this.#stacks.set(locale, stack)
    }

    // Copy: the caller's object is theirs to mutate, and a bundle that changes under
    // us would make the flattened cache lie.
    const layer = { ...messages }
    stack.push(layer)
    this.#flat.delete(locale)

    return {
      dispose: () => {
        const current = this.#stacks.get(locale)
        if (!current) return
        const i = current.indexOf(layer)
        if (i < 0) return
        current.splice(i, 1)
        this.#flat.delete(locale)
      },
    }
  }

  number(value: number, options?: Intl.NumberFormatOptions): string {
    return this.#formatter(options).format(value)
  }

  area(squareMetres: number): string {
    // Always m², with two decimals, never auto-switching to hectares. A land
    // registry records square metres; *which* unit to show a user is a domain
    // judgement, and a preset that wants hectares overrides `units.squareMetre`
    // and formats on top of number(). Fixed decimals also keep a column of areas
    // aligned, which is how a surveyor actually reads them.
    const value = this.number(squareMetres, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    return `${value} ${this.t('units.squareMetre')}`
  }

  onChange(handler: (locale: Locale) => void): Disposable {
    this.#handlers.push(handler)
    return {
      dispose: () => {
        const i = this.#handlers.indexOf(handler)
        if (i >= 0) this.#handlers.splice(i, 1)
      },
    }
  }

  #messages(locale: Locale): Messages {
    const cached = this.#flat.get(locale)
    if (cached) return cached

    const flat: Messages = {}
    // Oldest first, so the newest registration lands last and wins.
    for (const layer of this.#stacks.get(locale) ?? []) Object.assign(flat, layer)
    this.#flat.set(locale, flat)
    return flat
  }

  /**
   * Formatters are cached because constructing an `Intl.NumberFormat` is the
   * expensive part, and `area()` is called on every `pointermove` while a
   * measurement is live.
   */
  #formatter(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
    const key = `${this.#locale}|${options === undefined ? '' : JSON.stringify(options)}`
    const cached = this.#formatters.get(key)
    if (cached) return cached

    let formatter: Intl.NumberFormat
    try {
      formatter = new Intl.NumberFormat(this.#locale, options)
    } catch {
      // `Intl` throws a RangeError on a malformed tag, and `'tr_TR'` — underscore,
      // straight out of a server-side locale string — is malformed. Blanking the map
      // because of a punctuation mark in someone's config is not a defensible
      // failure mode; fall back and keep rendering.
      console.warn(
        `[fleximap] locale "${this.#locale}" is not a valid BCP-47 tag ` +
          `(did you mean "${this.#locale.replace(/_/g, '-')}"?). Formatting numbers as "${FALLBACK}".`,
      )
      formatter = new Intl.NumberFormat(FALLBACK, options)
    }

    this.#formatters.set(key, formatter)
    return formatter
  }
}

/** `'tr-TR'` → `['tr-TR', 'tr', 'en']`. A regional bundle falls back to its language, then to English. */
function fallbackChain(locale: Locale): Locale[] {
  const chain = [locale]

  const language = baseLanguage(locale)
  if (language !== locale) chain.push(language)
  if (!chain.includes(FALLBACK)) chain.push(FALLBACK)
  return chain
}

function baseLanguage(locale: Locale): Locale {
  const [language] = locale.split('-')
  // `toLowerCase()`, emphatically **not** `toLocaleLowerCase()`. Under a Turkish
  // host locale the latter maps `I` to the dotless `ı`, so the tag `ID` folds to
  // `ıd`, which is not Indonesian and matches nothing. BCP-47 tags are folded
  // invariantly.
  //
  // The trap is exactly inverted for *user text*: any case-insensitive comparison
  // on attribute values a Turkish surveyor typed **must** pass a locale
  // (`value.toLocaleLowerCase('tr')`), or `PARSEL` stops matching `parsel`. Wrong
  // default in either direction and search quietly breaks — which is why this
  // library never case-folds without saying which of the two cases it is in.
  return (language ?? locale).toLowerCase()
}

function interpolate(message: string, params: Record<string, unknown>): string {
  return message.replace(PLACEHOLDER, (match: string, name: string) => {
    const value = params[name]
    // Leave the placeholder standing rather than printing "undefined": it names the
    // parameter the caller forgot to pass.
    return value === undefined ? match : String(value)
  })
}
