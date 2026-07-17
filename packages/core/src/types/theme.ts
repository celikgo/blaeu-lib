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
    readonly surface: string
    readonly surfaceMuted: string
    readonly text: string
    readonly textMuted: string
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

export interface Theme {
  readonly id: string
  readonly tokens: ThemeTokens
  /**
   * A MapLibre style URL or style JSON for the basemap.
   *
   * Cadastre wants a pale, low-contrast basemap so parcel lines dominate. A game
   * map wants no basemap at all. That's a theme decision, not a config one.
   */
  readonly basemap?: string | Record<string, unknown>
  /** Raw CSS, injected scoped to the map container. The last resort, and that's fine. */
  readonly css?: string
}

export interface ThemeManager {
  readonly current: Theme
  set(theme: Theme | DeepPartial<Theme>): void
  /** Read one token. Plugins use this instead of hardcoding colours. */
  token<K extends keyof ThemeTokens>(group: K): ThemeTokens[K]
  onChange(handler: (theme: Theme) => void): Disposable
}
