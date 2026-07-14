import type { Messages } from '@fleximap/core'

/**
 * Turkish first, and with the words a planner uses.
 *
 * The vocabulary is the tell. *İmar planı*, not "zoning map". *Ada*, not "block".
 * *KAKS* (a.k.a. *emsal*) is the floor area ratio and *TAKS* is the ground coverage
 * ratio — a planner will say either "KAKS" or "emsal" depending on which document
 * they last read, so the label says both rather than making them guess which one
 * this field is. *Gabari* is the height cap. A *plan notu* is a legally binding
 * sentence attached to the plan, which is why it is a first-class field on the form
 * and not a "description".
 *
 * Getting this wrong is instantly visible to the only people who matter: translate
 * "zoning" to "bölgeleme" and a Turkish planner knows, in one glance, that nobody
 * asked one.
 */
export const tr: Messages = {
  /* legend */
  'urban.zoning.K': 'Konut Alanı',
  'urban.zoning.T': 'Ticaret Alanı',
  'urban.zoning.S': 'Sanayi Alanı',
  'urban.zoning.YA': 'Yeşil Alan',
  'urban.zoning.D': 'Donatı Alanı',
  'urban.zoning.unzoned': 'Fonksiyon Atanmamış',

  /* attribute form */
  'urban.field.zoning': 'İmar Fonksiyonu',
  'urban.field.kaks': 'KAKS (Emsal)',
  'urban.field.taks': 'TAKS',
  'urban.field.gabari': 'Gabari',
  'urban.field.planNotu': 'Plan Notu',
  'urban.field.ada': 'Ada',
  'urban.field.parsel': 'Parsel',

  /* tools, as a planner names them */
  'urban.tool.drawZone': 'İmar Adası Çiz',
  'urban.tool.editZone': 'Ada Düzenle',
  'urban.tool.measureArea': 'Alan Ölç',
  'urban.hint.grid': '5 m planlama gridine oturuyor',

  /* scenarios */
  'urban.scenario.create': 'Senaryo oluştur: {name}',
  'urban.scenario.switch': 'Senaryoya geç: {name}',
  'urban.scenario.compare': '{a} / {b} karşılaştırması',
  'urban.scenario.delta': 'Alan farkı',

  /* validation — the wording carries the severity */
  'urban.validation.overlap':
    'İki fonksiyon çakışıyor. Planı sonuçlandırmadan önce çözülmeli; taslak aşamasında sorun değil.',
  'urban.validation.minArea': 'Bu ada plan için fazla küçük ({area} m²).',
}

export const en: Messages = {
  'urban.zoning.K': 'Residential',
  'urban.zoning.T': 'Commercial',
  'urban.zoning.S': 'Industrial',
  'urban.zoning.YA': 'Green / Open Space',
  'urban.zoning.D': 'Public Facility',
  'urban.zoning.unzoned': 'Unassigned',

  'urban.field.zoning': 'Zoning function',
  // KAKS and TAKS are kept as the loanwords a planning office actually uses; "FAR"
  // alone would leave a Turkish planner reading an English UI hunting for emsal.
  'urban.field.kaks': 'Floor area ratio (KAKS/emsal)',
  'urban.field.taks': 'Ground coverage (TAKS)',
  'urban.field.gabari': 'Height limit (gabari)',
  'urban.field.planNotu': 'Plan note',
  'urban.field.ada': 'Block (ada)',
  'urban.field.parsel': 'Plot (parsel)',

  'urban.tool.drawZone': 'Draw zone',
  'urban.tool.editZone': 'Edit zone',
  'urban.tool.measureArea': 'Measure area',
  'urban.hint.grid': 'Snapped to the 5 m planning grid',

  'urban.scenario.create': 'Create scenario: {name}',
  'urban.scenario.switch': 'Switch to scenario: {name}',
  'urban.scenario.compare': 'Comparing {a} with {b}',
  'urban.scenario.delta': 'Area difference',

  'urban.validation.overlap':
    'Two functions overlap. Resolve before the plan is finalised; harmless while exploring.',
  'urban.validation.minArea': 'This zone is too small for a plan ({area} m²).',
}

export const urbanMessages: Readonly<Record<string, Messages>> = { tr, en }
