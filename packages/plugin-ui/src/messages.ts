import type { Messages } from '@fleximap/core'

/**
 * The UI's own vocabulary — and nothing else.
 *
 * There is not a single domain word here, and no tool label either. A tool's
 * label lives under `tool.<id>` and is registered by whoever registered the tool;
 * the cadastre preset then shadows `tool.draw:polygon` with "Parsel çiz" and this
 * package never learns that parcels exist. That layering is the whole reason the
 * toolbar can render a tool it has never heard of.
 */
export const en: Messages = {
  'ui.toolbar': 'Tools',
  'ui.status': 'Status',
  'ui.undo': 'Undo',
  'ui.redo': 'Redo',
  'ui.coordinates': 'Cursor position',
  'ui.coordinates.empty': '—',
  'ui.scale': 'Scale',
  'ui.attribution': 'Attribution',
  'ui.measure': 'Measurement',
  'ui.issues': 'Issues',
  'ui.issues.empty': 'No issues.',
  'ui.issues.count': '{count} issue(s)',
  'ui.issues.zoomTo': 'Zoom to the issue',
  'ui.issues.dismiss': 'Dismiss',

  'snap.kind.vertex': 'Vertex',
  'snap.kind.edge': 'Edge',
  'snap.kind.midpoint': 'Midpoint',
  'snap.kind.intersection': 'Intersection',
  'snap.kind.grid': 'Grid',
  'snap.kind.extension': 'Extension',
  'snap.kind.perpendicular': 'Perpendicular',
  'snap.kind.parallel': 'Parallel',
  'snap.kind.center': 'Centre',
}

export const tr: Messages = {
  'ui.toolbar': 'Araçlar',
  'ui.status': 'Durum',
  'ui.undo': 'Geri al',
  'ui.redo': 'Yinele',
  'ui.coordinates': 'İmleç konumu',
  'ui.coordinates.empty': '—',
  'ui.scale': 'Ölçek',
  'ui.attribution': 'Kaynak',
  'ui.measure': 'Ölçüm',
  'ui.issues': 'Sorunlar',
  'ui.issues.empty': 'Sorun yok.',
  'ui.issues.count': '{count} sorun',
  'ui.issues.zoomTo': 'Soruna yakınlaş',
  'ui.issues.dismiss': 'Kapat',

  'snap.kind.vertex': 'Köşe',
  'snap.kind.edge': 'Kenar',
  'snap.kind.midpoint': 'Orta nokta',
  'snap.kind.intersection': 'Kesişim',
  'snap.kind.grid': 'Izgara',
  'snap.kind.extension': 'Uzantı',
  'snap.kind.perpendicular': 'Dik',
  'snap.kind.parallel': 'Paralel',
  'snap.kind.center': 'Merkez',
}
