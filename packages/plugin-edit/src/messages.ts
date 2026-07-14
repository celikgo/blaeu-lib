import type { Messages } from '@fleximap/core'

/**
 * Undo-menu labels. A command's `label` is shown to the user ("Undo Move vertex"),
 * so it is localised at the point of dispatch rather than at the point of display —
 * by the time a history UI renders the stack, the locale may have changed, but the
 * label the user will recognise is the one from when they did the thing.
 */
export const en: Messages = {
  'edit.moveVertex': 'Move vertex',
  'edit.moveSharedVertex': 'Move shared corner',
  'edit.insertVertex': 'Insert vertex',
  'edit.deleteVertex': 'Delete vertex',
  'edit.move': 'Move',
  'edit.rotate': 'Rotate',
  'edit.scale': 'Scale',
  'edit.split': 'Split feature',
  'edit.merge': 'Merge features',
}

export const tr: Messages = {
  'edit.moveVertex': 'Köşe taşı',
  'edit.moveSharedVertex': 'Ortak köşe taşı',
  'edit.insertVertex': 'Köşe ekle',
  'edit.deleteVertex': 'Köşe sil',
  'edit.move': 'Taşı',
  'edit.rotate': 'Döndür',
  'edit.scale': 'Ölçekle',
  'edit.split': 'Parseli böl',
  'edit.merge': 'Parselleri birleştir',
}
