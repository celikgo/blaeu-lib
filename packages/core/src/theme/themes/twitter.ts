import type { Theme } from '../../types/theme.js'
import { buildTheme } from './build.js'

/**
 * The Twitter / X palettes — Light, Dim, and Lights-out.
 *
 * These reproduce X's three colour schemes, with three deliberate corrections where
 * X's own values fail WCAG and this is a field tool, not a timeline:
 *
 * - **White-on-blue is exactly 3.00:1** — X's most-cited contrast failure. A filled
 *   button therefore reads `accentStrong` (#1578C2, white label 4.67:1), while the
 *   vivid #1D9BF0 stays as the *map mark* and link colour, where 3:1 is enough.
 * - **On white, X's snap-yellow (#FFD400) is 1.43:1 — invisible.** The light theme's
 *   snap indicator is deepened to #C2410C (4.96:1). On the dark grounds the yellow is
 *   11–15:1, so Dim and Lights-out keep it.
 * - **Lights-out muted text on the panel grey was 3.88:1.** Nudged to #8B98A5 / #7E8388
 *   so it clears 4.5:1.
 *
 * Every text pair and every on-map mark in all three has a computed contrast on file.
 */

export const twitterLight: Theme = buildTheme({
  id: 'twitter-light',
  scheme: 'light',
  color: {
    canvas: '#FFFFFF',
    surface: '#FFFFFF',
    surfaceMuted: '#F7F9F9',
    text: '#0F1419',
    textMuted: '#536471',
    border: '#CFD9DE',
    accent: '#1D9BF0', // map mark / link: 3.00:1 on white (graphic, ok)
    accentStrong: '#1578C2', // filled button: white label 4.67:1
    onAccent: '#FFFFFF',
    selection: '#E01673', // 4.63:1 on white
    hover: '#F91880',
    vertex: '#FFFFFF',
    vertexActive: '#E01673',
    midpoint: '#8899A6',
    snapIndicator: '#C2410C', // deepened from X yellow, 4.96:1 on white
    guide: '#6941E0', // 6.12:1
    error: '#D91F2C', // 4.75:1 on the panel grey
    warning: '#A16207', // 4.66:1
    success: '#007A55', // 5.08:1
    labelHalo: '#FFFFFF',
  },
})

export const twitterDim: Theme = buildTheme({
  id: 'twitter-dim',
  scheme: 'dark',
  color: {
    canvas: '#15202B',
    surface: '#15202B',
    surfaceMuted: '#1E2732',
    text: '#F7F9F9', // 15.61:1
    textMuted: '#8B98A5', // 5.60:1
    border: '#38444D',
    accent: '#1D9BF0', // 5.50:1 on the dim ground
    accentStrong: '#1578C2', // filled button: white label 4.67:1
    onAccent: '#FFFFFF',
    selection: '#F91880', // 4.30:1 on ground
    hover: '#FF7ABF',
    vertex: '#FFFFFF',
    vertexActive: '#F91880',
    midpoint: '#5C6E7E',
    snapIndicator: '#FFD400', // X yellow: 11.52:1 on the dim ground
    guide: '#9B7BFF', // lifted for the dark ground
    error: '#F87171',
    warning: '#FFD400',
    success: '#00BA7C',
    labelHalo: '#15202B', // dark map → dark halo
  },
})

export const twitterBlack: Theme = buildTheme({
  id: 'twitter-black',
  scheme: 'dark',
  color: {
    canvas: '#000000',
    surface: '#000000',
    surfaceMuted: '#16181C',
    text: '#E7E9EA', // 17.24:1
    textMuted: '#7E8388', // 4.65:1 on the panel grey (X's own #71767B fails)
    border: '#2F3336',
    accent: '#1D9BF0', // 7.00:1 on black
    accentStrong: '#1578C2', // white label 4.67:1
    onAccent: '#FFFFFF',
    selection: '#F91880', // 5.47:1
    hover: '#FF7ABF',
    vertex: '#FFFFFF',
    vertexActive: '#F91880',
    midpoint: '#545B62',
    snapIndicator: '#FFD400', // 14.67:1
    guide: '#9B7BFF',
    error: '#F87171',
    warning: '#FFD400',
    success: '#00BA7C',
    labelHalo: '#000000',
  },
})
