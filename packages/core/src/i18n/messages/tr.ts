import type { Messages } from '../../types/i18n.js'

/**
 * Turkish is a first-class target, not a courtesy translation — the cadastre
 * preset ships with `locale: 'tr'` by default.
 *
 * Note the unit strings are identical to English: `m²` is `m²` everywhere. They
 * exist as keys anyway so that a preset can override the *presentation* (a
 * municipality that wants `m2` in a CSV export, say) without patching the kernel.
 */
export const tr: Messages = {
  'validation.severity.error': 'Hata',
  'validation.severity.warning': 'Uyarı',
  'validation.severity.info': 'Bilgi',
  'validation.failed': 'Doğrulama başarısız.',
  'validation.rejected': 'Değişiklik {count} doğrulama hatası nedeniyle reddedildi.',
  'validation.ruleThrew': '"{rule}" doğrulama kuralı çalıştırılamadı: {error}',

  'error.featureNotFound': '"{id}" nesnesi bulunamadı.',
  'error.collectionNotFound': '"{id}" koleksiyonu yok. Eklemeden önce oluşturun.',
  'error.invalidGeometry': 'Geometri geçerli değil.',
  'error.unsupportedGeometry': '"{type}" geometri türü bu işlemde desteklenmiyor.',
  'error.outOfCrsBounds': 'Koordinat {crs} sınırlarının dışında.',

  'units.metre': 'm',
  'units.squareMetre': 'm²',
  'units.degree': '°',
}
