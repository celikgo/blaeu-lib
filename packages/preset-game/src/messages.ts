import type { Messages } from '@blaeu/core'

/**
 * The preset's own strings.
 *
 * Registered *after* the plugins' bundles (the kernel installs preset i18n before
 * plugins run, and later registrations win per key), which is what lets a preset
 * rename a generic tool without the plugin containing a word of the domain: here,
 * the draw plugin's "Polygon" becomes "Zone", and it never learns that games exist.
 */
export const en: Messages = {
  'game.tool.place': 'Place entity',
  'game.tool.place.hint': 'Click a tile to place {entity}',
  'game.entity.none': 'No entity type selected',
  'game.rule.outOfBounds': '{entity} is outside the world bounds',
  'game.rule.tileOccupied': 'This tile already holds {other}',
  'game.grid.square': 'Square grid ({size} units)',
  'game.grid.hex': 'Hex grid ({size} units)',
  'snap.kind.grid': 'Tile',
  'snap.kind.hex-centre': 'Hex centre',
  'draw.polygon': 'Zone',
  'draw.tool.polygon': 'Draw zone',
}

export const tr: Messages = {
  'game.tool.place': 'Varlık yerleştir',
  'game.tool.place.hint': '{entity} yerleştirmek için bir kareye tıklayın',
  'game.entity.none': 'Varlık türü seçilmedi',
  'game.rule.outOfBounds': '{entity} dünya sınırlarının dışında',
  'game.rule.tileOccupied': 'Bu karede zaten {other} var',
  'game.grid.square': 'Kare ızgara ({size} birim)',
  'game.grid.hex': 'Altıgen ızgara ({size} birim)',
  'snap.kind.grid': 'Kare',
  'snap.kind.hex-centre': 'Altıgen merkezi',
  'draw.polygon': 'Bölge',
  'draw.tool.polygon': 'Bölge çiz',
}
