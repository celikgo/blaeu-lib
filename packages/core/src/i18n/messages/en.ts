import type { Messages } from '../../types/i18n.js'

/**
 * The kernel's own strings, and nothing more.
 *
 * Core owns generic vocabulary — severities, units, the handful of errors the
 * kernel itself can produce. Every domain word ("parcel", "zoning", "sliver")
 * belongs to a plugin or a preset bundle, which registers on top of this one.
 * A kernel that ships the word "parcel" has already decided what it is for.
 *
 * `'en'` is also the last stop in the fallback chain, so a key that is missing
 * here is a key the user will see raw.
 */
export const en: Messages = {
  'validation.severity.error': 'Error',
  'validation.severity.warning': 'Warning',
  'validation.severity.info': 'Info',
  'validation.failed': 'Validation failed.',
  'validation.rejected': 'The change was rejected by {count} validation error(s).',
  'validation.ruleThrew': 'Validation rule "{rule}" could not run: {error}',

  'error.featureNotFound': 'Feature "{id}" was not found.',
  'error.collectionNotFound': 'Collection "{id}" does not exist. Create it before adding to it.',
  'error.invalidGeometry': 'The geometry is not valid.',
  'error.unsupportedGeometry': 'Geometry type "{type}" is not supported by this operation.',
  'error.outOfCrsBounds': 'The coordinate lies outside the bounds of {crs}.',

  'units.metre': 'm',
  'units.squareMetre': 'm²',
  'units.degree': '°',
}
