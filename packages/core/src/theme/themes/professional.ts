import type { Theme } from '../../types/theme.js'
import { buildTheme } from './build.js'

/**
 * Survey Paper — a warm, low-contrast day theme for cadastral work.
 *
 * The ground is paper, not white, and everything is dialled *down* except the
 * boundary the surveyor is on: near-black parcel ink for the accent, a magenta
 * selection that survives against ink, brown building, and an amber snap — all
 * chosen so the one high-contrast thing on screen is the line being edited. It is
 * the cadastre preset's palette, promoted to a switchable, self-contained theme.
 */
export const surveyPaper: Theme = buildTheme({
  id: 'survey-paper',
  scheme: 'light',
  color: {
    canvas: '#FBFAF7',
    surface: '#FBFAF7',
    surfaceMuted: '#EFECE5',
    text: '#111827',
    textMuted: '#5B5B52', // 6.57:1
    border: '#D6D1C6',
    accent: '#1F2933', // near-black parcel ink
    accentStrong: '#1F2933', // white label 14.76:1
    onAccent: '#FFFFFF',
    selection: '#D6006F', // 4.92:1 on paper
    hover: '#FF6BB3',
    vertex: '#FFFFFF',
    vertexActive: '#D6006F',
    midpoint: '#B7AE9E',
    snapIndicator: '#C2410C', // 4.96:1
    guide: '#6941E0',
    error: '#C4162B', // 5.09:1
    warning: '#856404', // 4.66:1
    success: '#046C4E', // 5.46:1
    labelHalo: '#FBFAF7',
  },
  size: { vertexRadius: 4, lineWidth: 1.5 },
  font: { family: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  css: `.bl-ui-readout { font-variant-numeric: tabular-nums; }`,
})

/**
 * High Contrast — a WCAG AAA day theme for field use in direct sunlight.
 *
 * Every text pair clears 7:1 and every on-map mark clears 4.5:1; the border is pure
 * black. This is the theme a clerk switches to on a laptop screen at noon in a field,
 * where the pleasant greys of every other theme wash out completely.
 */
export const highContrast: Theme = buildTheme({
  id: 'high-contrast',
  scheme: 'light',
  color: {
    canvas: '#FFFFFF',
    surface: '#FFFFFF',
    surfaceMuted: '#F0F0F0',
    text: '#000000', // 21:1
    textMuted: '#3A3A3A', // 11.37:1
    border: '#000000',
    accent: '#0B3D91', // 10.04:1
    accentStrong: '#0B3D91',
    onAccent: '#FFFFFF',
    selection: '#A6006B', // 7.41:1
    hover: '#D1008A',
    vertex: '#FFFFFF',
    vertexActive: '#A6006B',
    midpoint: '#595959',
    snapIndicator: '#8A3A00', // 7.82:1
    guide: '#4B0FA8', // 10.86:1
    error: '#8B0F1D', // 8.44:1 (AAA)
    warning: '#5C4200', // 8.25:1 (AAA)
    success: '#02543F', // 7.87:1 (AAA)
    labelHalo: '#FFFFFF',
  },
})

/**
 * Imagery Dark — a night theme tuned to sit over satellite or orthophoto tiles.
 *
 * The accent is a cyan rather than a blue, because blue disappears into water and
 * shadow on an orthophoto; every mark is picked to hold up over a busy, mid-tone
 * image rather than over a flat panel. An app that supplies its own imagery basemap
 * registers a variant of this with `basemap` set to its tile style.
 */
export const imageryDark: Theme = buildTheme({
  id: 'imagery-dark',
  scheme: 'dark',
  color: {
    canvas: '#0B0F14',
    surface: '#10161D',
    surfaceMuted: '#18202A',
    text: '#E6EDF3', // 15.39:1
    textMuted: '#9BA9B4', // 7.56:1
    border: '#2A3542',
    accent: '#00D8F0', // cyan, 11.06:1 on the ground
    accentStrong: '#00D8F0',
    onAccent: '#041014', // dark on cyan, 11.09:1
    selection: '#FF2D95', // 5.55:1
    hover: '#FF7ABF',
    vertex: '#FFFFFF',
    vertexActive: '#FF2D95',
    midpoint: '#5A6B78',
    snapIndicator: '#FFD400', // 13.43:1
    guide: '#9B7BFF', // 6.11:1
    error: '#FF5A65',
    warning: '#FFD400',
    success: '#00E39A',
    labelHalo: '#000000', // dark halo for text over dark imagery
  },
})
