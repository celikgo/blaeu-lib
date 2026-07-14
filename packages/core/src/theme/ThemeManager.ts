import type { DeepPartial, Disposable } from '../types/common.js'
import type { Theme, ThemeManager, ThemeTokens } from '../types/theme.js'
import { defaultTheme } from './defaultTheme.js'

/** Unique per manager instance, so two maps on one page cannot inherit each other's CSS. */
let scopeCounter = 0

/**
 * Design tokens, in one place, feeding two consumers.
 *
 * Every token is written into the map container as a CSS custom property
 * (`--fx-color-accent`, `--fx-size-vertex-radius`) **and** is readable by plugins
 * through {@link token}, which is what a MapLibre paint expression needs. That is
 * the entire point of this class: the selection halo drawn on the map and the
 * highlighted row in the attribute table are the same blue because they read the
 * same number, not because two files happen to agree today.
 *
 * The moment those two live in separate places, they drift — and the drift is
 * never noticed by the person who caused it.
 */
export class FlexiThemeManager implements ThemeManager {
  readonly #container: HTMLElement
  readonly #scope = `fx-${++scopeCounter}`
  #theme: Theme = defaultTheme
  #handlers: ((theme: Theme) => void)[] = []
  #style: HTMLStyleElement | undefined
  #written: string[] = []
  #disposed = false

  constructor(container: HTMLElement) {
    this.#container = container
    // Apply immediately. A plugin that reads `var(--fx-color-accent)` in its own
    // stylesheet must not get an empty string just because nobody called set().
    this.#apply()
  }

  get current(): Theme {
    return this.#theme
  }

  /** Accepts a whole theme or a sparse patch; either way the result is a complete theme. */
  set(theme: Theme | DeepPartial<Theme>): void {
    this.#theme = mergeTheme(this.#theme, theme)
    this.#apply()

    for (const handler of [...this.#handlers]) {
      try {
        handler(this.#theme)
      } catch (err) {
        // One plugin's restyle throwing must not leave the other plugins holding
        // the old colours — a half-themed map is worse than a logged error.
        console.error('[fleximap] theme change handler threw:', err)
      }
    }
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

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true

    const style = elementStyle(this.#container)
    if (style) {
      // Remove only what we wrote. The container is the host app's element and may
      // carry custom properties of its own that predate us.
      for (const name of this.#written) style.removeProperty(name)
    }
    this.#written = []

    this.#style?.remove()
    this.#style = undefined
    if (typeof this.#container.removeAttribute === 'function') {
      this.#container.removeAttribute(SCOPE_ATTRIBUTE)
    }
    this.#handlers = []
  }

  #apply(): void {
    if (this.#disposed) return

    const style = elementStyle(this.#container)
    if (style) {
      const vars = cssVariables(this.#theme.tokens)
      for (const [name, value] of Object.entries(vars)) style.setProperty(name, value)
      this.#written = Object.keys(vars)
    }

    this.#applyCss(this.#theme.css)
  }

  #applyCss(css: string | undefined): void {
    this.#style?.remove()
    this.#style = undefined

    // Feature-detect the DOM instead of assuming it. The kernel is tested headless
    // against a stub container, and a `document is not defined` here would make the
    // whole store and command layer untestable without jsdom.
    if (css === undefined || typeof document === 'undefined') return
    if (typeof this.#container.setAttribute !== 'function') return

    this.#container.setAttribute(SCOPE_ATTRIBUTE, this.#scope)

    const element = document.createElement('style')
    element.setAttribute('data-fx-style', this.#scope)
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

const SCOPE_ATTRIBUTE = 'data-fx-scope'

/**
 * The signature says `HTMLElement`, but the test harness passes a stub and a
 * server-rendered host passes whatever it has. Trust the runtime, not the type.
 */
function elementStyle(element: HTMLElement): CSSStyleDeclaration | undefined {
  const style = (element as { style?: unknown }).style as CSSStyleDeclaration | undefined
  return typeof style?.setProperty === 'function' ? style : undefined
}

function mergeTheme(base: Theme, patch: Theme | DeepPartial<Theme>): Theme {
  const merged: {
    id: string
    tokens: ThemeTokens
    basemap?: string | Record<string, unknown>
    css?: string
  } = {
    id: patch.id ?? base.id,
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
  const basemap = patch.basemap ?? base.basemap
  if (basemap !== undefined) merged.basemap = basemap
  const css = patch.css ?? base.css
  if (css !== undefined) merged.css = css

  return merged
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
      vars[`--fx-${kebab(group)}-${kebab(key)}`] = cssValue(group, value)
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
