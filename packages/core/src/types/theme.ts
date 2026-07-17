import type { DeepPartial, Disposable } from './common.js'

/**
 * Design tokens.
 *
 * These feed **both** the UI chrome (as CSS custom properties: `--bl-color-accent`)
 * **and** the map styling (as values inside MapLibre paint expressions). That
 * single-source-of-truth is why the selection halo on the map is exactly the same
 * blue as the selected row in the attribute table — a detail that separates a
 * product from a demo, and one you cannot get if the map style and the CSS are
 * maintained separately.
 */
export interface ThemeTokens {
  readonly color: {
    readonly accent: string
    readonly accentMuted: string
    /**
     * A stronger accent, sized so that {@link onAccent} laid on top of it clears
     * 4.5:1. The plain `accent` is tuned to read as a *mark on the map* (3:1 is
     * enough for a graphic), and for several real palettes — Twitter blue on white
     * is exactly 3.00:1 — that same colour cannot legally carry white button text.
     * A filled control reads `accentStrong`/`onAccent`; a map mark reads `accent`.
     */
    readonly accentStrong: string
    /** The text/icon colour that sits *on* {@link accentStrong} (a filled button, the snap tooltip). */
    readonly onAccent: string
    readonly selection: string
    readonly hover: string
    readonly vertex: string
    readonly vertexActive: string
    readonly midpoint: string
    readonly snapIndicator: string
    readonly guide: string
    readonly error: string
    readonly warning: string
    readonly success: string
    /**
     * The map canvas itself — the ground the features are drawn on, *not* the panel
     * chrome. On a light theme it is near-{@link surface}; on a dark one it is the
     * thing that makes the map read as dark, and it is a different colour from the
     * dark panels floating above it. This is the token a theme's flat basemap paints
     * its `background` layer, so the map ground and the tokens can never disagree.
     */
    readonly canvas: string
    readonly surface: string
    readonly surfaceMuted: string
    readonly text: string
    readonly textMuted: string
    /**
     * The halo drawn *around on-map labels* — not to be confused with `surface`.
     * A label needs a halo the colour of the ground it sits on so it stays legible
     * over any feature: a light halo on a light map, a **dark** halo on a dark map.
     * Plugins that draw map text (measure, the parcel-number labels) read this, and
     * a light halo on a dark map — the bug you get by reusing `surface` — turns every
     * label into a bright smear.
     */
    readonly labelHalo: string
    readonly border: string
  }
  readonly size: {
    readonly vertexRadius: number
    readonly midpointRadius: number
    readonly lineWidth: number
    readonly snapIndicatorRadius: number
    readonly controlHeight: number
    readonly radius: number
  }
  readonly font: {
    readonly family: string
    readonly size: number
    readonly sizeSmall: number
  }
  readonly z: {
    readonly base: number
    readonly overlay: number
    readonly handles: number
    readonly indicator: number
  }
}

/** Light or dark. Drives the OS `color-scheme` on the container and picks the theme in `follow('auto')`. */
export type ColorScheme = 'light' | 'dark'

/** How the manager chooses between light and dark: pinned to one, or following the OS. */
export type SchemePreference = ColorScheme | 'auto'

export interface Theme {
  readonly id: string
  /**
   * Whether this theme reads as light or dark. It is not cosmetic: `follow('auto')`
   * uses it to pick the theme that matches the OS setting, and the manager stamps
   * `color-scheme` on the container from it so native scrollbars and form controls
   * flip too. A theme whose `canvas` is near-black but whose `scheme` says `'light'`
   * is a bug, and one nothing else can catch.
   */
  readonly scheme: ColorScheme
  readonly tokens: ThemeTokens
  /**
   * A MapLibre style URL or style JSON for the basemap.
   *
   * Cadastre wants a pale, low-contrast basemap so parcel lines dominate. A dark
   * theme wants a dark ground. That's a theme decision, not a config one — and it is
   * a *live* one: switching theme re-applies this to the renderer, which is why the
   * built-in dark themes ship a flat `background` style painted their `canvas`
   * colour rather than leaving a white map under dark features.
   *
   * `null` (not `undefined`) means "clear the previous theme's basemap". `undefined`
   * in a patch means "leave it as it is" — the distinction matters when you switch
   * from a theme that set a basemap to one that does not.
   */
  readonly basemap?: string | Record<string, unknown> | null
  /**
   * Raw CSS, injected scoped to the map container. The last resort, and that's fine.
   * `null` clears a previous theme's CSS; `undefined` in a patch leaves it untouched.
   */
  readonly css?: string | null
}

export interface ThemeManager {
  readonly current: Theme
  /** The active theme's colour scheme, for a plugin that must branch on light vs dark. */
  readonly scheme: ColorScheme
  set(theme: Theme | DeepPartial<Theme>): void
  /** Read one token. Plugins use this instead of hardcoding colours. */
  token<K extends keyof ThemeTokens>(group: K): ThemeTokens[K]
  onChange(handler: (theme: Theme) => void): Disposable

  /* ---- registry: named themes the app can switch between by id ---- */

  /** Add a theme to the registry so `use(theme.id)` can activate it. Re-registering an id replaces it. */
  register(theme: Theme): void
  /** Activate a registered theme by id. Throws if the id is unknown — a silent no-op here is a blank map nobody can explain. */
  use(id: string): void
  /** Every registered theme, for building a theme picker. */
  list(): readonly Theme[]
  has(id: string): boolean

  /**
   * Choose light/dark automatically from the OS (`'auto'`), or pin one.
   *
   * In `'auto'`, the manager watches `prefers-color-scheme` and switches between the
   * two themes named by {@link setSchemeDefaults} whenever the OS flips — live, at
   * sunset. An explicit {@link use} wins until `follow('auto')` is called again.
   */
  follow(preference: SchemePreference): void
  /** The two themes `follow('auto')` chooses between. Ids must already be registered. */
  setSchemeDefaults(defaults: { readonly light: string; readonly dark: string }): void
}
