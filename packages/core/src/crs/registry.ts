import type { CrsCode, ProjectedCrs } from '../types/crs.js'

/**
 * The built-in coordinate reference systems.
 *
 * A CRS definition here is a *claim*, and everything downstream trusts it: a
 * parcel area computed in the wrong plane is still a plausible number, and it
 * will be written onto a deed. So every EPSG code below was checked against the
 * EPSG registry rather than recalled. Where a code could not be verified, the
 * system would be registered under a descriptive custom code instead — a wrong
 * EPSG number is worse than no EPSG number, because a wrong one gets believed.
 */

/** A CRS definition without the parts the service supplies (converters, precision). */
export type CrsSpec = Omit<ProjectedCrs, 'forward' | 'inverse' | 'precision'>

/**
 * The interior CRS of the whole library (core invariant 3). Every converter we
 * build runs from here to somewhere, so a projected coordinate can only ever be
 * produced from a lng/lat — never from another projected coordinate that someone
 * forgot to unproject.
 */
export const WGS84_PROJ4 = '+proj=longlat +datum=WGS84 +no_defs'

/**
 * Codes that name a *geographic* CRS. These are not planes, and are refused as a
 * working CRS — see `BlaeuCrsService.setWorking`. EPSG:4326 is listed for exactly
 * that reason: so it can be recognised and rejected with a message that helps,
 * rather than silently accepted as a plane whose "metres" are degrees.
 */
export const GEOGRAPHIC_CODES: readonly CrsCode[] = ['EPSG:4326', 'CRS:84', 'OGC:CRS84', 'WGS84']

/** Millimetre. The cadastral default, and the grid the store quantises to on ingest. */
export const DEFAULT_PRECISION = 0.001

/** Türkiye's onshore envelope; the latitude span of every Turkish TM belt below. */
const TR_SOUTH = 35.5
const TR_NORTH = 42.5

/**
 * Bounds of a 3-degree TM belt: the ±1.5° of longitude either side of the central
 * meridian that the projection was designed for.
 *
 * Outside the belt the projection still *works* — proj4 will happily hand back a
 * coordinate — but the grid scale factor grows quadratically with distance from
 * the central meridian, so grid areas drift away from ground areas. Ankara
 * (32.85°E) in TUREF/TM30 is the worked example: 2.85° off the central meridian,
 * where a 2 000 m² parcel measures ~3 m² larger on the TM30 grid than on the TM33
 * grid it belongs in. Three square metres is a boundary dispute. These bounds
 * exist so that can be warned about rather than discovered in court.
 */
function belt(centralMeridian: number): readonly [number, number, number, number] {
  return [centralMeridian - 1.5, TR_SOUTH, centralMeridian + 1.5, TR_NORTH]
}

function tmBelt(code: CrsCode, name: string, cm: number, ellps: string, towgs84: string): CrsSpec {
  return {
    code,
    name,
    proj4:
      `+proj=tmerc +lat_0=0 +lon_0=${cm} +k=1 +x_0=500000 +y_0=0 ` +
      `+ellps=${ellps} +towgs84=${towgs84} +units=m +no_defs`,
    unit: 'metre',
    bounds: belt(cm),
  }
}

/**
 * TUREF — Türkiye Ulusal Referans Çerçevesi, the modern national frame: ITRF96
 * epoch 2005.0 on GRS80, which agrees with WGS84 far below anything a receiver
 * can measure. Hence `towgs84=0,0,0,0,0,0,0`, and hence a TUREF↔WGS84 conversion
 * is lossless in practice — which is what makes it safe for this library to hold
 * everything in WGS84 interiorly and still hand a surveyor numbers they can sign.
 * This is the system a Turkish cadastral survey is delivered in today.
 */
const TUREF_CM: readonly (readonly [CrsCode, number])[] = [
  ['EPSG:5253', 27],
  ['EPSG:5254', 30],
  ['EPSG:5255', 33],
  ['EPSG:5256', 36],
  ['EPSG:5257', 39],
  ['EPSG:5258', 42],
  ['EPSG:5259', 45],
]

const turefSpecs = TUREF_CM.map(([code, cm]) =>
  tmBelt(code, `TUREF / TM${cm}`, cm, 'GRS80', '0,0,0,0,0,0,0'),
)

/**
 * ED50 / TM27…TM45 — the *legacy* Turkish 3-degree Gauss-Krüger belts,
 * EPSG:2319…EPSG:2325. Decades of cadastral archive live in these, so an importer
 * that cannot read them cannot read Turkish data.
 *
 * Two warnings, both of which have bitten people:
 *
 * 1. **The datum shift is approximate.** `-84.1,-101.8,-129.7,0,0,0.468,1.05` is
 *    the published national Helmert transform and it is good to a couple of
 *    metres — fine for *displaying* an archived parcel on a modern basemap,
 *    useless for *certifying* a boundary. A legally defensible ED50→TUREF
 *    conversion in Türkiye uses the official regional transformation, which is
 *    not a seven-parameter shift and is not something this library should pretend
 *    to do. Convert for viewing; do not convert for the deed.
 *
 * 2. **Legacy eastings are often zone-prefixed.** Much archived data writes the
 *    belt number in front of the easting — `10 458 123.456` in zone 10, not
 *    `458 123.456` — a convention proj4 knows nothing about. An importer must
 *    strip it. A parcel that lands 10 000 km east of Türkiye has met exactly this.
 */
const ED50_CM: readonly (readonly [CrsCode, number])[] = [
  ['EPSG:2319', 27],
  ['EPSG:2320', 30],
  ['EPSG:2321', 33],
  ['EPSG:2322', 36],
  ['EPSG:2323', 39],
  ['EPSG:2324', 42],
  ['EPSG:2325', 45],
]

const ED50_TOWGS84 = '-84.1,-101.8,-129.7,0,0,0.468,1.05'

const ed50Specs = ED50_CM.map(([code, cm]) =>
  tmBelt(code, `ED50 / TM${cm}`, cm, 'intl', ED50_TOWGS84),
)

/** UTM 35N/36N/37N cover Türkiye, and turn up constantly in imported data. */
const UTM_ZONES: readonly (readonly [CrsCode, number, number])[] = [
  ['EPSG:32635', 35, 27],
  ['EPSG:32636', 36, 33],
  ['EPSG:32637', 37, 39],
]

const utmSpecs = UTM_ZONES.map(([code, zone, cm]): CrsSpec => {
  return {
    code,
    name: `WGS 84 / UTM zone ${zone}N`,
    proj4: `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`,
    unit: 'metre',
    // A UTM zone is 6° wide and, unlike the TM belts, is not Türkiye-specific.
    bounds: [cm - 3, 0, cm + 3, 84],
  }
})

/**
 * Web Mercator: the default working CRS, because it is the only choice that is
 * never *catastrophically* wrong for a map that has not yet said where it is.
 *
 * It is **not survey-grade**, and no number computed on it should ever be signed.
 * Web Mercator's scale factor is `1 / cos(latitude)`: at Ankara's 39.93°N a
 * "metre" on this plane is 1.30 real metres, so a planar area computed here comes
 * out ~70 % too large. The library will let you do it and the result will look
 * entirely reasonable, which is precisely the danger. Set a working CRS — a
 * TUREF/TM belt, in Türkiye — before measuring anything that matters.
 */
const webMercator: CrsSpec = {
  code: 'EPSG:3857',
  name: 'WGS 84 / Pseudo-Mercator',
  proj4:
    '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 ' +
    '+units=m +nadgrids=@null +no_defs',
  unit: 'metre',
  bounds: [-180, -85.06, 180, 85.06],
}

export const BUILTIN_CRS: readonly CrsSpec[] = [
  webMercator,
  ...turefSpecs,
  ...ed50Specs,
  ...utmSpecs,
]

/**
 * Deliberately **not** registered:
 *
 * - **EPSG:5636–5642**, which were suggested as the ED50 3-degree Gauss-Krüger
 *   codes. They are not: EPSG:5636 is *TUREF / LAEA Europe*, an equal-area
 *   projection for statistics. Registering the ED50 belts under those numbers
 *   would have produced a system that projected, measured, and lied. The verified
 *   ED50 belts are EPSG:2319–2325, above.
 *
 * - **EPSG:4326 as a plane.** Geographic, not projected. See `GEOGRAPHIC_CODES`.
 *
 * - **Municipal and utility grids.** Every large Turkish municipality has one, and
 *   guessing at them is the exact mistake this comment exists to prevent. They
 *   arrive through `crs.register({ code: 'IZMIR-BB-LOCAL', … })`, from the
 *   authority that owns the definition.
 */
