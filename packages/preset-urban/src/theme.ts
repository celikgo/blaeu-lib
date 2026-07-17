import type { DeepPartial, Theme } from '@blaeu/core'

/**
 * A *partial* theme, deliberately.
 *
 * `composePresets` deep-merges themes, so shipping the handful of tokens this domain
 * has an opinion about — and inheriting the rest from `defaultTheme` — means a
 * municipality's brand theme composed on top only has to restate what *it* cares
 * about. A preset that restated all forty tokens would silently re-impose the
 * default vertex radius on anyone who merged over it.
 *
 * What the domain actually has an opinion about: the chrome must recede. The zoning
 * fill is doing the talking, and a saturated accent colour next to five saturated
 * legend colours makes a map nobody can read. No `basemap` is set here for the same
 * reason a cadastre preset sets a pale one — but the choice of *which* pale basemap
 * is a deployment decision (a municipality has its own tiles, often on an intranet),
 * so it belongs in the host app's theme, not in a published default that would
 * hard-code somebody else's tile server.
 */
export const urbanTheme: DeepPartial<Theme> = {
  id: 'blaeu-urban',
  scheme: 'light',
  tokens: {
    color: {
      accent: '#1f6feb',
      accentMuted: '#9ec5fe',
      selection: '#111827',
      // Warm, so it survives being drawn on top of the yellow of a konut zone —
      // a cool hover on #f6c244 is invisible, which is the sort of thing you only
      // find by putting the two next to each other.
      hover: '#7c3aed',
      guide: '#6b7280',
      warning: '#b45309',
    },
    size: {
      // Bigger handles than cadastre's: a planner sketches at 1/5000 with a mouse
      // or a stylus on a tablet in a meeting, not with a survey-grade cursor.
      vertexRadius: 6,
      midpointRadius: 4,
      lineWidth: 1.5,
    },
  },
}
