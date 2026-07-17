import type { ColorScheme, Theme, ThemeTokens } from '../../types/theme.js'
import { defaultTheme } from '../defaultTheme.js'

/** A sparse colour patch — the handful of tokens a theme actually re-tints. */
type ColorPatch = Partial<ThemeTokens['color']>

export interface ThemeDraft {
  readonly id: string
  readonly scheme: ColorScheme
  readonly color: ColorPatch
  /** Override a size/font default only where the theme genuinely needs it (survey wants a smaller vertex). */
  readonly size?: Partial<ThemeTokens['size']>
  readonly font?: Partial<ThemeTokens['font']>
  /** Extra scoped CSS on top of the token variables (a font-feature setting, say). */
  readonly css?: string
}

/**
 * Turn a sparse draft into a complete, self-consistent {@link Theme}.
 *
 * Two invariants are enforced here rather than trusted to each theme author:
 *
 * 1. **The flat basemap is painted the theme's own `canvas` token.** A theme cannot
 *    ship a dark palette and forget to darken the ground — the ground *is* the token.
 *    This is what makes `theme.use('twitter-dim')` turn the map dark rather than
 *    leaving dark features floating on a white page.
 *
 * 2. **Every token has a value.** The draft patches `defaultTheme`, so a token the
 *    author did not mention is inherited, and a plugin reading `token('color').guide`
 *    never gets `undefined`.
 *
 * The basemap is deliberately offline — a `background` layer and nothing else, no
 * `sources`, no `glyphs`, no network. It is the ground colour, not a street map. An
 * app that wants real tiles under a theme registers a variant whose `basemap` is its
 * own style (and, if it draws on-map *text*, one that provides a `glyphs` endpoint —
 * a flat basemap has none, so a symbol layer over it renders no labels).
 */
export function buildTheme(draft: ThemeDraft): Theme {
  const color = { ...defaultTheme.tokens.color, ...draft.color }
  const theme: Theme = {
    id: draft.id,
    scheme: draft.scheme,
    tokens: {
      color,
      size: { ...defaultTheme.tokens.size, ...draft.size },
      font: { ...defaultTheme.tokens.font, ...draft.font },
      z: { ...defaultTheme.tokens.z },
    },
    basemap: flatBasemap(color.canvas),
    ...(draft.css !== undefined ? { css: draft.css } : {}),
  }
  return theme
}

/** A single-colour MapLibre background style. The whole "no basemap, this colour" case in one object. */
export function flatBasemap(canvas: string): Record<string, unknown> {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'blaeu:canvas', type: 'background', paint: { 'background-color': canvas } }],
  }
}
