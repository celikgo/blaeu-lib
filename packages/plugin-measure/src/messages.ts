import type { Messages } from '@fleximap/core'

/**
 * The plugin's own strings. Registered on top of the core bundles, so a preset
 * registered *after* the plugin can rename any of them — "Alan ölç" → "Parsel alanı"
 * — without this file containing a word about parcels.
 *
 * `units.metre`, `units.squareMetre` and `units.degree` are deliberately **not**
 * here: they belong to the core, and overriding them from a plugin would change the
 * unit shown by every other plugin too.
 */

export const en: Messages = {
  'measure.tool.distance': 'Measure distance',
  'measure.tool.area': 'Measure area',
  'measure.tool.bearing': 'Measure bearing',

  'measure.label.distance': 'Distance',
  'measure.label.area': 'Area',
  'measure.label.perimeter': 'Perimeter',
  'measure.label.bearing': 'Bearing',

  'measure.command.add': 'Measure',
  'measure.command.clear': 'Clear measurements',
  'measure.command.draft': 'Measuring',

  'measure.hint.distance': 'Click to add a point, double-click to finish.',
  'measure.hint.area': 'Click to add a corner, double-click to close the area.',
  'measure.hint.bearing': 'Click the two ends of the line.',

  'measure.units.kilometre': 'km',
  'measure.units.hectare': 'ha',
  'measure.units.squareKilometre': 'km²',
  // The Turkish land-area unit, 1 000 m². Not translated in English either — a
  // dönüm is a dönüm, the same way a hectare is a hectare.
  'measure.units.donum': 'dönüm',
}

export const tr: Messages = {
  'measure.tool.distance': 'Mesafe ölç',
  'measure.tool.area': 'Alan ölç',
  'measure.tool.bearing': 'Semt açısı ölç',

  'measure.label.distance': 'Mesafe',
  'measure.label.area': 'Alan',
  'measure.label.perimeter': 'Çevre',
  'measure.label.bearing': 'Semt açısı',

  'measure.command.add': 'Ölçüm',
  'measure.command.clear': 'Ölçümleri temizle',
  'measure.command.draft': 'Ölçülüyor',

  'measure.hint.distance': 'Nokta eklemek için tıklayın, bitirmek için çift tıklayın.',
  'measure.hint.area': 'Köşe eklemek için tıklayın, alanı kapatmak için çift tıklayın.',
  'measure.hint.bearing': 'Doğrunun iki ucuna tıklayın.',

  'measure.units.kilometre': 'km',
  'measure.units.hectare': 'ha',
  'measure.units.squareKilometre': 'km²',
  'measure.units.donum': 'dönüm',
}
