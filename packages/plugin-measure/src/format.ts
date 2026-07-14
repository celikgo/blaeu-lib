import type { I18n } from '@fleximap/core'
import type { AreaUnit, BearingReadout, LengthUnit } from './types.js'

/**
 * Formatting, and only formatting. Every number arriving here is already planar
 * metres out of the working CRS; this file turns it into something a human reads.
 *
 * All of it goes through `I18n`, never through `toFixed()`. A Turkish surveyor
 * reads `1.234,56 m²` — dot for thousands, comma for decimals — and a number
 * formatted the English way in a Turkish UI does not merely look foreign, it is
 * ambiguous: `1,234` is either one point two or one thousand two hundred, and
 * which one it is decides whether a parcel is a shed or a football pitch.
 */

/** m² per unit. `dönüm` is exactly 1 000 m² — a definition, not an approximation. */
const SQUARE_METRES_PER: Readonly<Record<AreaUnit, number>> = {
  m2: 1,
  ha: 10_000,
  km2: 1_000_000,
  donum: 1_000,
}

const AREA_UNIT_KEY: Readonly<Record<AreaUnit, string>> = {
  m2: 'units.squareMetre',
  ha: 'measure.units.hectare',
  km2: 'measure.units.squareKilometre',
  donum: 'measure.units.donum',
}

const METRES_PER: Readonly<Record<LengthUnit, number>> = { m: 1, km: 1_000 }

const LENGTH_UNIT_KEY: Readonly<Record<LengthUnit, string>> = {
  m: 'units.metre',
  km: 'measure.units.kilometre',
}

/** Decimals per unit: enough to be useful, few enough that a column of them lines up. */
const AREA_DECIMALS: Readonly<Record<AreaUnit, number>> = { m2: 2, ha: 4, km2: 6, donum: 3 }
const LENGTH_DECIMALS: Readonly<Record<LengthUnit, number>> = { m: 2, km: 3 }

export function formatArea(squareMetres: number, unit: AreaUnit, i18n: I18n): string {
  // The core's own `area()` is the m² path, deliberately: it is what the rest of
  // FlexiMap formats areas with, and routing through it means a preset that
  // overrides `units.squareMetre` changes this label too, for free.
  if (unit === 'm2') return i18n.area(squareMetres)

  const decimals = AREA_DECIMALS[unit]
  const value = i18n.number(squareMetres / SQUARE_METRES_PER[unit], {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  return `${value} ${i18n.t(AREA_UNIT_KEY[unit])}`
}

export function formatLength(metres: number, unit: LengthUnit, i18n: I18n): string {
  const decimals = LENGTH_DECIMALS[unit]
  const value = i18n.number(metres / METRES_PER[unit], {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  return `${value} ${i18n.t(LENGTH_UNIT_KEY[unit])}`
}

/**
 * A grid bearing in both forms at once: `123° 45' 12" (123,7533°)`.
 *
 * The DMS numbers are not localised — degrees, minutes and seconds are integers
 * and carry no separators, and `123° 45' 12"` is written the same way in every
 * locale FlexiMap targets. The decimal form *is* localised, because it has a
 * decimal separator and that is exactly the character locales disagree about.
 */
export function formatBearing(degrees: number, i18n: I18n): BearingReadout {
  const normalised = normaliseDegrees(degrees)
  const decimal = `${i18n.number(normalised, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })}${i18n.t('units.degree')}`

  return { degrees: normalised, dms: toDms(normalised), decimal }
}

/** `123.7533` → `123° 45' 12"`. */
export function toDms(degrees: number): string {
  const total = normaliseDegrees(degrees)

  let d = Math.floor(total)
  let m = Math.floor((total - d) * 60)
  // Rounding seconds can carry all the way up: 12.99999° must print as 13° 00' 00",
  // never as 12° 59' 60" — which is not a bearing, it is a typo with a degree sign.
  let s = Math.round(((total - d) * 60 - m) * 60)
  if (s === 60) {
    s = 0
    m += 1
  }
  if (m === 60) {
    m = 0
    d += 1
  }
  if (d === 360) d = 0

  return `${d}° ${pad(m)}' ${pad(s)}"`
}

/** Wraps into `[0, 360)`. A bearing of -90° is 270°, and of 361° is 1°. */
export function normaliseDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  const wrapped = degrees % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}
