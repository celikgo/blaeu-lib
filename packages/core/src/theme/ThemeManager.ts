import type { DeepPartial, Disposable } from '../types/common.js'
import type {
  ColorScheme,
  SchemePreference,
  Theme,
  ThemeManager,
  ThemeTokens,
} from '../types/theme.js'
import { defaultTheme } from './defaultTheme.js'
import { builtinThemes, DEFAULT_SCHEME_THEMES } from './themes/index.js'

/** Unique per manager instance, so two maps on one page cannot inherit each other's CSS. */
let scopeCounter = 0

/**
 * Design tokens, in one place, feeding two consumers.
 *
 * Every token is written into the map container as a CSS custom property
 * (`--bl-color-accent`, `--bl-size-vertex-radius`) **and** is readable by plugins
 * through {@link token}, which is what a MapLibre paint expression needs. That is
 * the entire point of this class: the selection halo drawn on the map and the
 * highlighted row in the attribute table are the same blue because they read the
 * same number, not because two files happen to agree today.
 *
 * The moment those two live in separate places, they drift — and the drift is
 * never noticed by the person who caused it.
 *
 * On top of the token bus sits a small **theme registry**: named themes the app can
 * switch between by id, and a `follow('auto')` mode that tracks the OS light/dark
 * setting and flips live. The kernel's built-in themes are registered on every
 * manager, so `map.theme.use('twitter-dim')` works with no setup.
 */
export class BlaeuThemeManager implements ThemeManager {
  readonly #container: HTMLElement
  readonly #scope = `bl-${++scopeCounter}`
  #theme: Theme = defaultTheme
  #handlers: ((theme: Theme) => void)[] = []
  #style: HTMLStyleElement | undefined
  #written: string[] = []
  #disposed = false

  readonly #registry = new Map<string, Theme>()
  #schemeDefaults: { light: string; dark: string } = { ...DEFAULT_SCHEME_THEMES }
  #following = false
  #mql: MediaQueryList | undefined
  readonly #onOsChange = (): void => {
    if (this.#following) this.#applyForScheme(osScheme())
  }

  constructor(container: HTMLElement) {
    this.#container = container
    this.register(defaultTheme)
    for (const theme of builtinThemes) this.register(theme)
    // Apply immediately. A plugin that reads `var(--bl-color-accent)` in its own
    // stylesheet must not get an empty string just because nobody called set().
    this.#apply()
  }

  get current(): Theme {
    return this.#theme
  }

  get scheme(): ColorScheme {
    return this.#theme.scheme
  }

  /** Accepts a whole theme or a sparse patch; either way the result is a complete theme. */
  set(theme: Theme | DeepPartial<Theme>): void {
    this.#theme = mergeTheme(this.#theme, theme)
    this.#apply()
    this.#notify()
  }

  token<K extends keyof ThemeTokens>(group: K): ThemeTokens[K] {
    return this.#theme.tokens[group]
  }

  onChange(handler: (theme: Theme) => void): Disposable {
    this.#handlers.push(handler)
    return {
      dispose: () => {
        const i = this.#handlers.indexOf(handler)
        if (i >= 0) this.#handlers.splice(i, 1)
      },
    }
  }

  /* ---- registry ---- */

  register(theme: Theme): void {
    if (!theme || typeof theme.id !== 'string' || theme.id === '') {
      throw new Error('[blaeu] theme.register() needs a theme with a non-empty string id.')
    }
    this.#registry.set(theme.id, theme)
  }

  use(id: string): void {
    if (this.#disposed) return
    const theme = this.#registry.get(id)
    if (!theme) {
      throw new Error(
        `[blaeu] theme.use("${id}") — no theme with that id is registered. ` +
          `Registered: [${[...this.#registry.keys()].join(', ')}]. ` +
          `Call theme.register(theme) first, or use one of those ids.`,
      )
    }
    // An explicit choice wins over the OS. Stop following, then activate — the manual
    // pin sticks until follow('auto') is called again.
    this.#following = false
    this.#activate(theme)
  }

  /**
   * Activate a *whole* theme, authoritatively.
   *
   * Unlike {@link set}, which takes a sparse patch and inherits what the patch omits,
   * activating a full theme must *replace* — a theme that names no basemap means "no
   * basemap", not "keep the last theme's". Without this, switching from `twitter-dim`
   * (a dark flat ground) to a basemap-less theme would leave the light chrome sitting
   * on the dark ground, and a scoped-CSS theme's rules would linger under the next
   * theme that ships none. So omitted `basemap`/`css` are coerced to `null` (clear).
   */
  #activate(theme: Theme): void {
    this.set({ ...theme, basemap: theme.basemap ?? null, css: theme.css ?? null })
  }

  list(): readonly Theme[] {
    return [...this.#registry.values()]
  }

  has(id: string): boolean {
    return this.#registry.has(id)
  }

  /* ---- light / dark policy ---- */

  setSchemeDefaults(defaults: { readonly light: string; readonly dark: string }): void {
    if (this.#disposed) return
    for (const id of [defaults.light, defaults.dark]) {
      if (!this.#registry.has(id)) {
        throw new Error(
          `[blaeu] setSchemeDefaults() names "${id}", which is not registered. ` +
            `Register the theme before making it a scheme default.`,
        )
      }
    }
    this.#schemeDefaults = { light: defaults.light, dark: defaults.dark }
    if (this.#following) this.#applyForScheme(osScheme())
  }

  follow(preference: SchemePreference): void {
    if (this.#disposed) return
    if (preference === 'auto') {
      this.#following = true
      this.#watchOs()
      this.#applyForScheme(osScheme())
      return
    }
    // A pinned light/dark is a manual choice: stop tracking the OS and show that
    // scheme's default theme.
    this.#following = false
    this.#applyForScheme(preference)
  }

  #applyForScheme(scheme: ColorScheme): void {
    const id = this.#schemeDefaults[scheme]
    const theme = this.#registry.get(id)
    // A scheme default is a full theme, so activate it authoritatively (replace, not patch).
    if (theme) this.#activate(theme)
  }

  #watchOs(): void {
    if (this.#mql || typeof window === 'undefined' || typeof window.matchMedia !== 'function')
      return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    // `addEventListener` on a MediaQueryList is the modern API; the old `addListener`
    // is kept as a fallback for Safari < 14, which a field laptop may well be running.
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', this.#onOsChange)
    else if (typeof mql.addListener === 'function') mql.addListener(this.#onOsChange)
    this.#mql = mql
  }

  #unwatchOs(): void {
    const mql = this.#mql
    if (!mql) return
    if (typeof mql.removeEventListener === 'function')
      mql.removeEventListener('change', this.#onOsChange)
    else if (typeof mql.removeListener === 'function') mql.removeListener(this.#onOsChange)
    this.#mql = undefined
  }

  #notify(): void {
    for (const handler of [...this.#handlers]) {
      try {
        handler(this.#theme)
      } catch (err) {
        // One plugin's restyle throwing must not leave the other plugins holding
        // the old colours — a half-themed map is worse than a logged error.
        console.error('[blaeu] theme change handler threw:', err)
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#unwatchOs()
    this.#following = false

    const style = elementStyle(this.#container)
    if (style) {
      // Remove only what we wrote. The container is the host app's element and may
      // carry custom properties of its own that predate us.
      for (const name of this.#written) style.removeProperty(name)
      style.removeProperty('color-scheme')
    }
    this.#written = []

    this.#style?.remove()
    this.#style = undefined
    if (typeof this.#container.removeAttribute === 'function') {
      this.#container.removeAttribute(SCOPE_ATTRIBUTE)
    }
    this.#handlers = []
    this.#registry.clear()
  }

  #apply(): void {
    if (this.#disposed) return

    const style = elementStyle(this.#container)
    if (style) {
      const vars = cssVariables(this.#theme.tokens)
      for (const [name, value] of Object.entries(vars)) style.setProperty(name, value)
      this.#written = Object.keys(vars)
      // Tell the browser which scheme the container is in, so native scrollbars,
      // form controls and the default text-selection colour flip with the theme.
      style.setProperty('color-scheme', this.#theme.scheme)
    }

    this.#applyCss(this.#theme.css)
  }

  #applyCss(css: string | null | undefined): void {
    this.#style?.remove()
    this.#style = undefined

    // Feature-detect the DOM instead of assuming it. The kernel is tested headless
    // against a stub container, and a `document is not defined` here would make the
    // whole store and command layer untestable without jsdom.
    if (css === undefined || css === null || typeof document === 'undefined') return
    if (typeof this.#container.setAttribute !== 'function') return

    this.#container.setAttribute(SCOPE_ATTRIBUTE, this.#scope)

    const element = document.createElement('style')
    element.setAttribute('data-bl-style', this.#scope)
    // Native CSS nesting scopes the theme's rules to this container without us
    // shipping a CSS parser. The trade-off is real and worth knowing: top-level
    // at-rules (@font-face, @import) are not legal inside a nesting block, so a
    // theme that needs a web font must load it itself.
    element.textContent = `[${SCOPE_ATTRIBUTE}="${this.#scope}"] {\n${css}\n}`

    const parent =
      typeof this.#container.appendChild === 'function' ? this.#container : document.head
    parent.appendChild(element)
    this.#style = element
  }
}

const SCOPE_ATTRIBUTE = 'data-bl-scope'

/** `dark` when the OS asks for dark; `light` otherwise, and when there is no OS to ask. */
function osScheme(): ColorScheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * The signature says `HTMLElement`, but the test harness passes a stub and a
 * server-rendered host passes whatever it has. Trust the runtime, not the type.
 */
function elementStyle(element: HTMLElement): CSSStyleDeclaration | undefined {
  const style = (element as { style?: unknown }).style as CSSStyleDeclaration | undefined
  return typeof style?.setProperty === 'function' ? style : undefined
}

interface MutableTheme {
  id: string
  scheme: ColorScheme
  tokens: ThemeTokens
  basemap?: string | Record<string, unknown>
  css?: string
}

function mergeTheme(base: Theme, patch: Theme | DeepPartial<Theme>): Theme {
  const merged: MutableTheme = {
    id: patch.id ?? base.id,
    scheme: patch.scheme ?? base.scheme,
    tokens: {
      color: mergeGroup(base.tokens.color, patch.tokens?.color),
      size: mergeGroup(base.tokens.size, patch.tokens?.size),
      font: mergeGroup(base.tokens.font, patch.tokens?.font),
      z: mergeGroup(base.tokens.z, patch.tokens?.z),
    },
  }

  // `basemap` and `css` are replaced wholesale rather than deep-merged. Merging two
  // MapLibre style JSONs field-by-field yields the layers of one and the sources of
  // the other, which renders as a blank map and takes an afternoon to diagnose.
  //
  // Three states, and the distinction is load-bearing:
  //   null      → clear it (switching from a theme that set a basemap to one that does not)
  //   undefined → leave it as the base has it (a sparse patch that says nothing about basemap)
  //   a value   → use it
  assignReplaceable(merged, 'basemap', patch.basemap, base.basemap)
  assignReplaceable(merged, 'css', patch.css, base.css)

  return merged
}

function assignReplaceable<K extends 'basemap' | 'css'>(
  merged: MutableTheme,
  key: K,
  patchValue: MutableTheme[K] | null | undefined,
  baseValue: MutableTheme[K] | null | undefined,
): void {
  if (patchValue === null) return // explicit clear
  const next = patchValue ?? baseValue
  if (next != null) merged[key] = next // `!= null` drops both null and undefined
}

function mergeGroup<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return base
  const out = { ...base } as Record<string, unknown>
  for (const key of Object.keys(patch) as (keyof T & string)[]) {
    const value = patch[key]
    // An explicit `undefined` in a DeepPartial means "not specified", never "unset
    // this token" — there is no such thing as a map with no accent colour.
    if (value !== undefined) out[key] = value
  }
  return out as T
}

function cssVariables(tokens: ThemeTokens): Record<string, string> {
  const groups = tokens as unknown as Record<string, Record<string, string | number>>
  const vars: Record<string, string> = {}

  for (const group of Object.keys(groups)) {
    const values = groups[group]
    if (!values) continue
    for (const key of Object.keys(values)) {
      const value = values[key]
      if (value === undefined) continue
      vars[`--bl-${kebab(group)}-${kebab(key)}`] = cssValue(group, value)
    }
  }
  return vars
}

function cssValue(group: string, value: string | number): string {
  if (typeof value === 'string') return value
  // Stacking order is unitless; every other number we ship is a CSS pixel length.
  // `token()` still hands plugins the raw number, because a MapLibre paint
  // expression wants `5`, not `'5px'` — the unit belongs to CSS, not to the token.
  return group === 'z' ? String(value) : `${value}px`
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}
