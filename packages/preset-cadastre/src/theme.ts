import { defaultTheme, type Theme } from '@blaeu/core'

/**
 * The palette, exported so the layer styles and the UI chrome read the *same*
 * hex values. A parcel outline that is #1f2933 on the map and #212121 in the
 * legend is the kind of near-miss that makes a product feel assembled rather
 * than designed.
 */
export const CADASTRE_COLORS = {
  /** Near-black, not black: pure black on a pale basemap is harsh at 100 % zoom for eight hours. */
  parcelLine: '#1f2933',
  /** A wash, not a fill. Parcels are outlines; the fill exists only to make them clickable. */
  parcelFill: '#3f4c5a',
  buildingLine: '#8a5a3b',
  buildingFill: '#b98559',
  label: '#111827',
  labelHalo: '#ffffff',
  /**
   * Magenta, and deliberately not a blue.
   *
   * Selection has to be unmistakable against near-black parcel lines, a brown
   * building footprint, an amber snap indicator *and* a grey orthophoto — all at
   * once, on a laptop screen in daylight in a field. Blue loses to the orthophoto.
   */
  selection: '#d6006f',
  hover: '#ff6bb3',
  /** Paper. The map is a survey sheet, and it should look like one. */
  surface: '#fbfaf7',
  surfaceMuted: '#efece5',
} as const

/**
 * Pale, low-contrast chrome so that the only high-contrast thing on the screen is
 * the boundary the surveyor is working on.
 *
 * Everything else is dialled *down*: the basemap, the building footprints, the
 * page background. That is not a stylistic preference — a cadastral map is read by
 * following one line, and every other saturated pixel is competing with it.
 */
export const cadastreTheme: Theme = {
  id: 'cadastre',
  scheme: 'light',
  tokens: {
    ...defaultTheme.tokens,
    color: {
      ...defaultTheme.tokens.color,
      accent: CADASTRE_COLORS.parcelLine,
      accentMuted: '#6b7785',
      // The pressed toolbar button: near-black ink under a white glyph reads on
      // paper the way the parcel ink reads on the map — the same colour, the same job.
      accentStrong: CADASTRE_COLORS.parcelLine,
      onAccent: '#ffffff',
      selection: CADASTRE_COLORS.selection,
      hover: CADASTRE_COLORS.hover,
      vertexActive: CADASTRE_COLORS.selection,
      // The ground is the survey sheet. The default near-white canvas would read as a
      // seam against the paper surface; they are the same paper on purpose.
      canvas: CADASTRE_COLORS.surface,
      surface: CADASTRE_COLORS.surface,
      surfaceMuted: CADASTRE_COLORS.surfaceMuted,
      text: CADASTRE_COLORS.label,
      labelHalo: CADASTRE_COLORS.labelHalo,
      border: '#d6d1c6',
    },
    size: {
      ...defaultTheme.tokens.size,
      // 4 px rather than the default 5: a cadastral corner is a *point*, and a fat
      // handle hides the very pixel the surveyor is trying to place it on.
      vertexRadius: 4,
      lineWidth: 1.5,
    },
    font: {
      ...defaultTheme.tokens.font,
      // Tabular figures, because a coordinate readout that jitters as the digits
      // change width is unreadable at 60 Hz.
      family: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    },
  },
  css: `
    .maplibregl-canvas-container { background: ${CADASTRE_COLORS.surface}; }
    .bl-coordinate-readout { font-variant-numeric: tabular-nums; }
  `,
}

export interface PaleBasemapOptions {
  readonly attribution?: string
  readonly tileSize?: number
  readonly maxZoom?: number
  /** -1 is fully grey. -0.85 keeps just enough colour to tell a field from a roof. */
  readonly saturation?: number
  /** How far the basemap fades behind the parcel lines. */
  readonly opacity?: number
}

/**
 * A raster basemap, desaturated and faded, ready to hand to `cadastrePreset({ basemap })`.
 *
 * The parameters exist because the right amount of fade depends on what is behind
 * it: an orthophoto needs more suppression than a street map. What does *not* vary
 * is the direction — the basemap is context, and context that competes with the
 * boundary is worse than no context.
 *
 * ```ts
 * cadastrePreset({
 *   basemap: paleRasterBasemap(['https://ortho.example.gov.tr/{z}/{x}/{y}.png'], {
 *     attribution: 'Ortofoto © HGM',
 *   }),
 * })
 * ```
 */
export function paleRasterBasemap(
  tiles: readonly string[],
  options: PaleBasemapOptions = {},
): Record<string, unknown> {
  if (tiles.length === 0) {
    throw new Error(
      '[blaeu] paleRasterBasemap() needs at least one tile URL template, e.g. ' +
        "paleRasterBasemap(['https://tiles.example.com/{z}/{x}/{y}.png']).",
    )
  }

  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [...tiles],
        tileSize: options.tileSize ?? 256,
        maxzoom: options.maxZoom ?? 20,
        ...(options.attribution !== undefined ? { attribution: options.attribution } : {}),
      },
    },
    layers: [
      {
        id: 'basemap',
        type: 'background',
        paint: { 'background-color': CADASTRE_COLORS.surface },
      },
      {
        id: 'basemap-raster',
        type: 'raster',
        source: 'basemap',
        paint: {
          'raster-saturation': options.saturation ?? -0.85,
          'raster-opacity': options.opacity ?? 0.55,
          'raster-contrast': -0.15,
        },
      },
    ],
  }
}
