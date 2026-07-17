import { defaultTheme, type Theme } from '@blaeu/core'
import type { ResolvedGameOptions } from './types.js'

/**
 * The game theme.
 *
 * **`basemap` is a flat colour, and that is the argument this package exists to
 * make.** A cadastre map is drawn *on top of* the world; a game map *is* the world.
 * There is no OSM tile to fetch, no attribution to show, no satellite imagery to
 * fade back — so the basemap is a single MapLibre `background` layer and nothing
 * else, and every pixel on screen after that is the level.
 *
 * It is a whole style object rather than a URL because `Theme.basemap` accepts
 * either, and a style object is the only way to say "no basemap, this colour"
 * without shipping a hosted style somewhere just to be the absence of one.
 */
export function gameTheme(options: ResolvedGameOptions): Theme {
  return {
    id: 'blaeu-game',
    scheme: 'dark',
    basemap: {
      version: 8,
      // No sprite, no glyphs, no sources: nothing is fetched over the network to
      // render this map. A level editor works on a plane, and so should offline.
      sources: {},
      layers: [
        {
          id: 'game:background',
          type: 'background',
          paint: { 'background-color': options.backgroundColor },
        },
      ],
    },
    tokens: {
      ...defaultTheme.tokens,
      color: {
        ...defaultTheme.tokens.color,
        // A dark editor chrome, because the canvas is dark: the cadastre palette's
        // white surfaces would sit on this background like a lightbox.
        accent: '#4ade80',
        accentMuted: '#166534',
        // The filled control is bright green with near-black text on it — the reverse
        // of the light themes, because on a green this dark text wins over white.
        accentStrong: '#4ade80',
        onAccent: '#0d1117',
        selection: '#4ade80',
        hover: '#86efac',
        vertex: '#f8fafc',
        vertexActive: '#4ade80',
        // Amber against a green accent — the snap indicator must stay legible when it
        // lands on an already-selected entity.
        snapIndicator: '#fbbf24',
        guide: '#38bdf8',
        // The ground is the level: the theme's canvas is the world's background, so
        // the flat basemap and the token agree, and on-map labels get a dark halo.
        canvas: options.backgroundColor,
        surface: '#161b22',
        surfaceMuted: '#21262d',
        text: '#e6edf3',
        textMuted: '#8b949e',
        labelHalo: options.backgroundColor,
        border: '#30363d',
      },
      size: {
        ...defaultTheme.tokens.size,
        // Bigger than cadastre's 5 px: a level designer is dragging entities, not
        // digitising a boundary, and precision is provided by the grid rather than
        // by the size of the handle.
        vertexRadius: 6,
        snapIndicatorRadius: 10,
      },
    },
  }
}
