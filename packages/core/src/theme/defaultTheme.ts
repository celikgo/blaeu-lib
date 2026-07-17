import type { Theme } from '../types/theme.js'

/**
 * The theme every map starts with.
 *
 * It is deliberately neutral — a slate/blue chrome that reads on both a satellite
 * basemap and a white cadastral one. A preset is expected to override it; the job
 * of the default is to make an un-themed map look *deliberate* rather than
 * unfinished, and to guarantee that every token a plugin reads has a value.
 */
export const defaultTheme: Theme = {
  id: 'blaeu-default',
  scheme: 'light',
  tokens: {
    color: {
      accent: '#2563eb',
      accentMuted: '#93c5fd',
      // Darker than `accent`: white on #2563eb is 5.17:1, so a filled button is legible.
      accentStrong: '#1d4ed8',
      onAccent: '#ffffff',
      selection: '#2563eb',
      hover: '#60a5fa',
      // Vertices are white with an accent stroke rather than solid accent: a solid
      // blue handle vanishes against blue selection fill and against water.
      vertex: '#ffffff',
      vertexActive: '#2563eb',
      midpoint: '#cbd5e1',
      // A deep amber, and specifically *not* a blue: a snap indicator that lands on
      // an already-selected vertex must stay distinguishable from the selection. Deep
      // rather than bright so the tooltip's light label clears 4.5:1 on it (the old
      // #f59e0b was 2.15:1 — an unreadable readout) and the ring holds 3:1 on a white
      // ground. The dark themes lift it back to a bright yellow, which their dark
      // label reads on cleanly.
      snapIndicator: '#b45309',
      guide: '#a855f7',
      error: '#dc2626',
      warning: '#d97706',
      success: '#16a34a',
      // The map ground. Near-white for the neutral default, and a hair off pure
      // white so a white feature fill still has an edge against it.
      canvas: '#fafbfc',
      surface: '#ffffff',
      surfaceMuted: '#f1f5f9',
      text: '#0f172a',
      textMuted: '#64748b',
      // Light map → light halo. The dark themes override this to a dark colour.
      labelHalo: '#ffffff',
      border: '#cbd5e1',
    },
    size: {
      // 5 px, because a vertex handle must be grabbable with a finger on a tablet
      // in the field without covering the corner it represents.
      vertexRadius: 5,
      midpointRadius: 3,
      lineWidth: 2,
      // Larger than the vertex it snaps to — the indicator has to be visible
      // *around* the handle, not under it.
      snapIndicatorRadius: 8,
      controlHeight: 32,
      radius: 6,
    },
    font: {
      family: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      size: 13,
      sizeSmall: 11,
    },
    z: {
      base: 0,
      overlay: 10,
      handles: 20,
      // The snap indicator sits above the handles it points at, or it is invisible
      // at exactly the moment it matters.
      indicator: 30,
    },
  },
}
