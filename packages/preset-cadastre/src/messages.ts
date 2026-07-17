import type { Locale, Messages } from '@blaeu/core'

/**
 * The cadastral vocabulary — the part of this package a surveyor will judge in the
 * first ten seconds.
 *
 * The words are not translations of English GIS terms; they are the terms of art
 * printed on a Turkish tapu and spoken in a Kadastro Müdürlüğü. `parsel`, not
 * `parça`. `yüzölçümü`, not `alan` (which is "area" in the sense a mathematician
 * means, and is what a surveyor calls the *number*, not the *field*). `sınırlandırma`
 * for the act of boundary determination, `malik` for the owner of record — not
 * `sahip`, which is what you call the owner of a dog.
 *
 * `tool.<id>` keys are how a preset renames a plugin's tool: the draw plugin
 * registers `draw:polygon` and never says a word about what a polygon *is* here.
 * That is the whole layering — "Parsel çiz" lives in this file and nowhere else.
 */
export const tr: Messages = {
  /* Tool labels — what the toolbar shows. */
  'tool.draw:polygon': 'Parsel çiz',
  'tool.draw:line': 'Sınır çiz',
  'tool.draw:point': 'Nokta ekle',
  'tool.draw:rectangle': 'Dikdörtgen parsel',
  'tool.edit:vertex': 'Köşe düzenle',
  'tool.select:single': 'Seç',
  'tool.select:box': 'Alanla seç',
  'tool.measure:distance': 'Mesafe ölç',
  'tool.measure:area': 'Yüzölçümü ölç',
  'tool.measure:bearing': 'Semt açısı',

  /* The parcel record. These are the column headings on a tapu. */
  'cadastre.parcel': 'Parsel',
  'cadastre.parcels': 'Parseller',
  'cadastre.building': 'Yapı',
  'cadastre.buildings': 'Yapılar',
  'cadastre.attr.ada': 'Ada',
  'cadastre.attr.parsel': 'Parsel',
  'cadastre.attr.pafta': 'Pafta',
  'cadastre.attr.malik': 'Malik',
  'cadastre.attr.nitelik': 'Nitelik',
  'cadastre.attr.mevkii': 'Mevkii',
  'cadastre.attr.yuzolcumu': 'Yüzölçümü',
  'cadastre.attr.yuzolcumu.hint': 'Geometriden hesaplanır; elle girilmez.',
  'cadastre.attr.missing': '{feature}: {field} girilmemiş.',
  'cadastre.attr.type': '{feature}: {field} alanı {expected} türünde olmalı.',
  'cadastre.attr.pattern': '{feature}: {field} değeri "{value}" beklenen biçimde değil.',
  'cadastre.attr.tooLong': '{feature}: {field} en çok {max} karakter olabilir.',

  /* The work itself. */
  'cadastre.boundary': 'Sınır',
  'cadastre.boundaryDetermination': 'Sınırlandırma',
  'cadastre.sharedBoundary': 'Ortak sınır',
  'cadastre.corner': 'Köşe noktası',
  'cadastre.subdivision': 'İfraz',
  'cadastre.merge': 'Tevhit',
  'cadastre.area': 'Yüzölçümü',
  'cadastre.perimeter': 'Çevre',
  'cadastre.coordinateList': 'Koordinat özet cetveli',

  /* Units. Dönüm is 1 000 m² — it is what the number is *said* in, out loud. */
  'cadastre.unit.donum': 'dönüm',
  'cadastre.unit.m2': 'm²',
  'cadastre.unit.hectare': 'hektar',

  /* Hints. Terse: they are read mid-gesture, out of the corner of an eye. */
  'cadastre.hint.drawParcel': 'Köşeleri sırayla tıklayın; halkayı kapatmak için çift tıklayın.',
  'cadastre.hint.snapping': 'Komşu parselin köşesine yaklaşınca yakalanır.',
  'cadastre.hint.topologicalEdit': 'Ortak köşe, iki parselde birden taşınır.',
  'cadastre.hint.autoArea': 'Yüzölçümü her kayıtta geometriden yeniden hesaplanır.',
}

export const en: Messages = {
  'tool.draw:polygon': 'Draw parcel',
  'tool.draw:line': 'Draw boundary',
  'tool.draw:point': 'Add point',
  'tool.draw:rectangle': 'Rectangular parcel',
  'tool.edit:vertex': 'Edit corner',
  'tool.select:single': 'Select',
  'tool.select:box': 'Box select',
  'tool.measure:distance': 'Measure distance',
  'tool.measure:area': 'Measure area',
  'tool.measure:bearing': 'Grid bearing',

  'cadastre.parcel': 'Parcel',
  'cadastre.parcels': 'Parcels',
  'cadastre.building': 'Building',
  'cadastre.buildings': 'Buildings',
  // The Turkish field names are kept alongside the English gloss on purpose: an
  // international consultant reading this UI still has to type the value into a
  // form whose column is called `ada`, and hiding that helps nobody.
  'cadastre.attr.ada': 'Block (ada)',
  'cadastre.attr.parsel': 'Parcel (parsel)',
  'cadastre.attr.pafta': 'Sheet (pafta)',
  'cadastre.attr.malik': 'Owner of record (malik)',
  'cadastre.attr.nitelik': 'Land use (nitelik)',
  'cadastre.attr.mevkii': 'Locality (mevkii)',
  'cadastre.attr.yuzolcumu': 'Area (yüzölçümü)',
  'cadastre.attr.yuzolcumu.hint': 'Derived from the geometry; not typed.',
  'cadastre.attr.missing': '{feature}: {field} is empty.',
  'cadastre.attr.type': '{feature}: {field} must be a {expected}.',
  'cadastre.attr.pattern': '{feature}: {field} value "{value}" is not in the expected format.',
  'cadastre.attr.tooLong': '{feature}: {field} may be at most {max} characters.',

  'cadastre.boundary': 'Boundary',
  'cadastre.boundaryDetermination': 'Boundary determination',
  'cadastre.sharedBoundary': 'Shared boundary',
  'cadastre.corner': 'Corner point',
  'cadastre.subdivision': 'Subdivision',
  'cadastre.merge': 'Merge',
  'cadastre.area': 'Area',
  'cadastre.perimeter': 'Perimeter',
  'cadastre.coordinateList': 'Coordinate schedule',

  'cadastre.unit.donum': 'dönüm',
  'cadastre.unit.m2': 'm²',
  'cadastre.unit.hectare': 'hectare',

  'cadastre.hint.drawParcel': 'Click each corner in turn; double-click to close the ring.',
  'cadastre.hint.snapping': 'Corners snap to a neighbouring parcel when you get close.',
  'cadastre.hint.topologicalEdit': 'A shared corner moves in both parcels at once.',
  'cadastre.hint.autoArea': 'The area is recomputed from the geometry on every save.',
}

/** Both bundles, keyed by locale. What the preset's `i18n` block is. */
export const cadastreMessages: Readonly<Record<Locale, Messages>> = { tr, en }
