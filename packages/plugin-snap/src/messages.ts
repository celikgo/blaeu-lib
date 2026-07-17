import type { Messages } from '@blaeu/core'

/**
 * The hints the snap indicator shows.
 *
 * Registered by the plugin, overridable by a preset — which is how the cadastre
 * preset renames "Vertex" to "Parsel köşesi" without this package containing a word
 * of Turkish or knowing that cadastre exists.
 */
export const snapMessagesEn: Messages = {
  'snap.vertex': 'Vertex',
  'snap.intersection': 'Intersection',
  'snap.midpoint': 'Midpoint',
  'snap.edge': 'Edge',
  'snap.extension': 'Extension',
  'snap.perpendicular': 'Perpendicular',
  'snap.grid': 'Grid',
}

export const snapMessagesTr: Messages = {
  'snap.vertex': 'Köşe',
  'snap.intersection': 'Kesişim',
  'snap.midpoint': 'Orta nokta',
  'snap.edge': 'Kenar',
  'snap.extension': 'Uzantı',
  'snap.perpendicular': 'Dik',
  'snap.grid': 'Izgara',
}
