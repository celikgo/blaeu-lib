import { describe, expect, it, vi } from 'vitest'
import type { Polygon, Position } from 'geojson'

import type { LngLat, ProjectedXY } from '../types/common.js'
import type { CrsCode, ProjectedCrs } from '../types/crs.js'
import { BlaeuCrsService } from './CrsService.js'
import { bboxAround } from '../utils/geometry.js'

/** Ankara. Note it sits at 32.85°E — inside the TM33 belt, *not* TM30's. That is deliberate. */
const ANKARA: LngLat = [32.85, 39.93]

function crsService(working: CrsCode = 'EPSG:5254', precision = 3): BlaeuCrsService {
  return new BlaeuCrsService({ working, display: 'projected', precision })
}

/**
 * Build a polygon that is an exact rectangle **on the plane** — the only way to
 * have a parcel whose true grid area is known to the millimetre. The corners are
 * unprojected to lng/lat because that is what the store holds; the whole point of
 * the exercise is that `area()` gets 2 000 m² back out.
 */
function planarRectangle(
  plane: ProjectedCrs,
  origin: LngLat,
  width: number,
  height: number,
): Polygon {
  const [x, y] = plane.forward(origin)
  const corners: ProjectedXY[] = [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
    [x, y],
  ]
  return { type: 'Polygon', coordinates: [corners.map((xy) => [...plane.inverse(xy)])] }
}

/**
 * @turf/area's algorithm (Chamberlain–Duquette spherical excess), reproduced here
 * rather than imported.
 *
 * The core does not depend on Turf for measurement, and must not: this function
 * is the *wrong answer*, kept in the test suite as the thing we are proving we do
 * not do. Importing it as a dependency would put it one autocomplete away from
 * someone's cadastral code.
 */
function sphericalArea(polygon: Polygon): number {
  const EARTH_RADIUS = 6378137
  const rad = (degrees: number): number => (degrees * Math.PI) / 180

  const ringArea = (ring: Position[]): number => {
    if (ring.length <= 2) return 0
    let total = 0
    for (let i = 0; i < ring.length; i++) {
      const lower = ring[i]!
      const middle = ring[(i + 1) % ring.length]!
      const upper = ring[(i + 2) % ring.length]!
      total += (rad(upper[0]!) - rad(lower[0]!)) * Math.sin(rad(middle[1]!))
    }
    return Math.abs((total * EARTH_RADIUS * EARTH_RADIUS) / 2)
  }

  return polygon.coordinates.reduce(
    (total, ring, index) => (index === 0 ? ringArea(ring) : total - ringArea(ring)),
    0,
  )
}

describe('the built-in registry', () => {
  const crs = crsService()

  it('registers the seven TUREF/TM belts, the seven ED50/TM belts, UTM 35–37N and Web Mercator', () => {
    const codes = crs.list()

    for (const code of [
      'EPSG:5253',
      'EPSG:5254',
      'EPSG:5255',
      'EPSG:5256',
      'EPSG:5257',
      'EPSG:5258',
      'EPSG:5259',
    ]) {
      expect(codes).toContain(code)
    }
    for (const code of [
      'EPSG:2319',
      'EPSG:2320',
      'EPSG:2321',
      'EPSG:2322',
      'EPSG:2323',
      'EPSG:2324',
      'EPSG:2325',
    ]) {
      expect(codes).toContain(code)
    }
    expect(codes).toContain('EPSG:32635')
    expect(codes).toContain('EPSG:32636')
    expect(codes).toContain('EPSG:32637')
    expect(codes).toContain('EPSG:3857')
  })

  /**
   * The strongest single assertion available about a transverse-Mercator
   * definition: on the central meridian at the equator, the projected coordinate
   * *is* the false origin. It pins the central meridian, the false easting, the
   * false northing and the scale factor all at once — so a TM33 string typo'd into
   * the TM30 slot cannot survive it.
   */
  it.each([
    ['EPSG:5253', 27],
    ['EPSG:5254', 30],
    ['EPSG:5255', 33],
    ['EPSG:5256', 36],
    ['EPSG:5257', 39],
    ['EPSG:5258', 42],
    ['EPSG:5259', 45],
  ])('%s puts the false origin exactly on the %i° central meridian', (code, meridian) => {
    const [easting, northing] = crs.get(code)!.forward([meridian, 0])
    expect(easting).toBeCloseTo(500000, 6)
    expect(northing).toBeCloseTo(0, 6)
  })

  /**
   * ED50 is a different datum, so the same *WGS84* lng/lat does not land on the
   * false origin — it lands ~136 m away. That offset is the datum shift doing its
   * job; a `towgs84` that had been dropped or zeroed would show up here as an
   * exact 500000, and a legacy parcel would then be silently ~136 m out of place.
   */
  it.each([
    ['EPSG:2319', 27],
    ['EPSG:2320', 30],
    ['EPSG:2321', 33],
    ['EPSG:2322', 36],
    ['EPSG:2323', 39],
    ['EPSG:2324', 42],
    ['EPSG:2325', 45],
  ])('%s applies the ED50 datum shift on the %i° central meridian', (code, meridian) => {
    const [easting, northing] = crs.get(code)!.forward([meridian, 0])
    const offset = Math.hypot(easting - 500000, northing)
    expect(offset).toBeGreaterThan(1)
    expect(offset).toBeLessThan(300)
  })

  it('reports Ankara as outside the TM30 belt but inside TM33 — the warning that bounds exist for', () => {
    expect(crs.withinBounds(ANKARA, 'EPSG:5254')).toBe(false)
    expect(crs.withinBounds(ANKARA, 'EPSG:5255')).toBe(true)
  })

  it('is case- and whitespace-insensitive about codes', () => {
    expect(crs.get(' epsg:5254 ')?.code).toBe('EPSG:5254')
  })
})

describe('forward / inverse', () => {
  it('round-trips Ankara through EPSG:5254 to well under a millimetre', () => {
    const crs = crsService('EPSG:5254')
    const plane = crs.working

    const back = plane.inverse(plane.forward(ANKARA))

    // Asserted in metres, never in decimal places: `toBeCloseTo(lng, 6)` means a
    // different distance at 39°N than at 60°N, which makes it a flake generator.
    expect(crs.distance(ANKARA, back)).toBeLessThan(0.0001)
  })

  it('projects Ankara to a plausible TM30 grid coordinate', () => {
    const [easting, northing] = crsService('EPSG:5254').working.forward(ANKARA)

    // 2.85° east of the central meridian ⇒ ~243 km of easting on top of the
    // 500 km false origin; ~4 425 km north of the equator at 39.93°N.
    expect(easting).toBeGreaterThan(740_000)
    expect(easting).toBeLessThan(745_000)
    expect(northing).toBeGreaterThan(4_420_000)
    expect(northing).toBeLessThan(4_430_000)
  })

  it('throws, rather than returning NaN, on a coordinate it cannot project', () => {
    const plane = crsService().working
    // proj4 rejects a non-finite input itself; our own guard catches the harder
    // case, a definition that *returns* NaN. Either way the caller gets a stack
    // trace instead of a coordinate that renders as "nothing there".
    expect(() => plane.forward([Number.NaN, 39.93])).toThrow(/finite|cannot project/i)
  })
})

describe('area', () => {
  it('measures a known 2 000 m² rectangle to within a part per million', () => {
    const crs = crsService('EPSG:5254')
    const parcel = planarRectangle(crs.working, ANKARA, 50, 40)

    expect(crs.area(parcel)).toBeCloseTo(2000, 3)
    expect(Math.abs(crs.area(parcel) - 2000) / 2000).toBeLessThan(1e-6)
  })

  /**
   * THE test. This file exists because Turf's area is spherical.
   *
   * A parcel that is exactly 2 000.000 m² on the TUREF/TM30 grid — the number the
   * land registry works from, because it is what the projected coordinates on the
   * plan say — measures 1 999.465 m² on a sphere. Half a square metre, on a parcel
   * that would fit in a garden, produced by a library call that reads perfectly in
   * review. That is the whole argument for this file.
   */
  it('disagrees with spherical (Turf-style) area by half a square metre — which is why this file exists', () => {
    const crs = crsService('EPSG:5254')
    const parcel = planarRectangle(crs.working, ANKARA, 50, 40)

    const planar = crs.area(parcel)
    const spherical = sphericalArea(parcel)

    expect(planar).toBeCloseTo(2000, 3)
    expect(Math.abs(planar - spherical)).toBeGreaterThan(0.1)
  })

  /**
   * And the spherical error is not even a *constant* bias, which is what makes it
   * genuinely dangerous rather than merely wrong.
   *
   * Two effects run in opposite directions: Turf's sphere uses the equatorial
   * radius, which over-reads area at Turkish latitudes by ~+2.4 m²; the TM grid's
   * scale factor over-reads by ~+2.9 m² at 2.85° off the central meridian. At
   * Ankara-in-TM30 they nearly cancel and spherical looks almost right (it is
   * 0.5 m² low). Move the same parcel into the belt it actually belongs to and the
   * cancellation stops: spherical is now 2.4 m² *high*. A bias that flips sign
   * depending on where the parcel sits in its zone cannot be calibrated away, and
   * cannot be reasoned about by anyone who did not already know it was there.
   */
  it('...and the spherical error changes sign with the belt, so it cannot be calibrated away', () => {
    const inTm30 = planarRectangle(crsService('EPSG:5254').working, ANKARA, 50, 40)
    const inTm33 = planarRectangle(crsService('EPSG:5255').working, ANKARA, 50, 40)

    expect(sphericalArea(inTm30) - 2000).toBeLessThan(0)
    expect(sphericalArea(inTm33) - 2000).toBeGreaterThan(2)
  })

  /**
   * The other half of the same lesson: the plane you measure *in* is part of the
   * answer. Ankara belongs to the TM33 belt. Measured in TM30 — 2.85° off its
   * central meridian — the identical parcel gains ~3 m², because that is what a
   * grid scale factor of 1.00073 does when you square it.
   */
  it('gives a different area in the wrong TM belt — 3 m² on 2 000 m², which is a dispute', () => {
    const crs = crsService('EPSG:5254')
    const parcel = planarRectangle(crs.working, ANKARA, 50, 40)
    const inTm30 = crs.area(parcel)

    crs.setWorking('EPSG:5255')
    const inTm33 = crs.area(parcel)

    expect(inTm30).toBeCloseTo(2000, 3)
    expect(Math.abs(inTm30 - inTm33)).toBeGreaterThan(2)
  })

  it('subtracts holes', () => {
    const crs = crsService('EPSG:5254')
    const plane = crs.working
    const outer = planarRectangle(plane, ANKARA, 50, 40)

    const [x, y] = plane.forward(ANKARA)
    const hole: ProjectedXY[] = [
      [x + 10, y + 10],
      [x + 20, y + 10],
      [x + 20, y + 20],
      [x + 10, y + 20],
      [x + 10, y + 10],
    ]
    // Wound the same way as the shell, on purpose: real data does this constantly,
    // and a hole must still be *subtracted* rather than added.
    const withHole: Polygon = {
      type: 'Polygon',
      coordinates: [outer.coordinates[0]!, hole.map((xy) => [...plane.inverse(xy)])],
    }

    expect(crs.area(withHole)).toBeCloseTo(1900, 3)
  })

  it('is zero for points and lines', () => {
    const crs = crsService()
    expect(crs.area({ type: 'Point', coordinates: [...ANKARA] })).toBe(0)
    expect(
      crs.area({
        type: 'LineString',
        coordinates: [
          [32.85, 39.93],
          [32.86, 39.94],
        ],
      }),
    ).toBe(0)
  })

  /**
   * Web Mercator is the default because it is never *catastrophically* wrong for a
   * map that has not said where it is — but it is never survey-grade either. At
   * Ankara's latitude its scale factor is 1/cos(39.93°) = 1.304, so an area comes
   * out 1.304² ≈ 1.70× too large: a 2 000 m² parcel measures ~3 400 m². This test
   * is the receipt for that claim, so nobody has to rediscover it on a deed.
   */
  it('inflates area by ~70 % on Web Mercator at Ankara — the default is not survey-grade', () => {
    const surveyGrade = crsService('EPSG:5254')
    const parcel = planarRectangle(surveyGrade.working, ANKARA, 50, 40)

    const webMercator = crsService('EPSG:3857')
    expect(webMercator.area(parcel)).toBeGreaterThan(3300)
    expect(webMercator.area(parcel)).toBeLessThan(3500)
  })
})

describe('length, distance and bearing', () => {
  const crs = crsService('EPSG:5254')
  const plane = crs.working
  const [x, y] = plane.forward(ANKARA)
  const at = (dx: number, dy: number): LngLat => plane.inverse([x + dx, y + dy])

  it('measures a 3-4-5 path in metres', () => {
    const line = {
      type: 'LineString' as const,
      coordinates: [[...at(0, 0)], [...at(3, 0)], [...at(3, 4)]],
    }
    expect(crs.length(line)).toBeCloseTo(7, 6)
  })

  it('measures a polygon perimeter, closing segment included', () => {
    expect(crs.length(planarRectangle(plane, ANKARA, 50, 40))).toBeCloseTo(180, 5)
  })

  it('measures planar distance in metres', () => {
    expect(crs.distance(at(0, 0), at(30, 40))).toBeCloseTo(50, 6)
  })

  it('reports grid bearing clockwise from grid north', () => {
    const origin = at(0, 0)
    expect(crs.bearing(origin, at(0, 10))).toBeCloseTo(0, 5)
    expect(crs.bearing(origin, at(10, 0))).toBeCloseTo(90, 5)
    expect(crs.bearing(origin, at(0, -10))).toBeCloseTo(180, 5)
    expect(crs.bearing(origin, at(-10, 0))).toBeCloseTo(270, 5)
    expect(crs.bearing(origin, at(10, 10))).toBeCloseTo(45, 5)
  })
})

describe('quantise', () => {
  const crs = crsService('EPSG:5254', 3)

  it('lands exactly on the 1 mm grid of the projected plane', () => {
    const quantised = crs.working.forward(crs.quantise([32.8500012345, 39.9300043219]))

    for (const component of quantised) {
      // Asserted with a metric tolerance, not bit-equality. `quantise` rounds on
      // the plane, but the *store* holds lng/lat — so getting back to metres here
      // costs one more proj4 round-trip, worth ~1e-7 m. The coordinate sits on the
      // millimetre grid to within a micrometre, which is four orders of magnitude
      // finer than the grid it is snapped to and is the residual we can actually
      // promise.
      const offGrid = Math.abs(component - Math.round(component * 1000) / 1000)
      expect(offGrid).toBeLessThan(1e-6)
    }
  })

  it('is idempotent', () => {
    const once = crs.quantise([32.8500012345, 39.9300043219])
    expect(crs.quantise(once)).toEqual(once)
  })

  /**
   * The bug this method is shaped to prevent: rounding *degrees* to 3 dp is a
   * ~85 m grid at Turkish latitudes, not a 1 mm one. If `quantise` ever regresses
   * to `Number(lng.toFixed(3))`, this assertion fails by four orders of magnitude.
   */
  it('moves a coordinate by less than a millimetre, not by 85 metres', () => {
    const point: LngLat = [32.8500012345, 39.9300043219]
    expect(crs.distance(point, crs.quantise(point))).toBeLessThan(0.001)
  })

  it('rejects a precision that is a grid size rather than a count of decimal places', () => {
    expect(() => crsService('EPSG:5254', 0.001)).toThrow(/decimal places/)
  })
})

describe('format', () => {
  const crs = crsService('EPSG:5254')

  it('labels the projected style Y=easting, X=northing — the Turkish convention', () => {
    const formatted = crs.format(ANKARA, { style: 'projected' })

    expect(formatted).toMatch(/^Y=\d+\.\d{3} {2}X=\d+\.\d{3}$/)

    // Y really is the easting: ~743 km, not the ~4 425 km northing. Getting this
    // backwards plots the parcel in the Indian Ocean, and does so silently.
    const [, easting, northing] = /^Y=([\d.]+) {2}X=([\d.]+)$/.exec(formatted)!
    expect(Number(easting)).toBeGreaterThan(700_000)
    expect(Number(northing)).toBeGreaterThan(4_000_000)
  })

  it('formats degrees-minutes-seconds', () => {
    expect(crs.format(ANKARA, { style: 'dms' })).toBe(`39°55'48.000"N  32°51'00.000"E`)
  })

  it('formats decimal degrees in lng, lat order', () => {
    expect(crs.format(ANKARA, { style: 'decimal' })).toBe('32.8500000, 39.9300000')
  })

  it('falls back to the configured display style', () => {
    expect(crs.format(ANKARA)).toMatch(/^Y=/)
  })
})

describe('parse', () => {
  const crs = crsService('EPSG:5254')

  it('round-trips the projected format exactly', () => {
    const quantised = crs.quantise(ANKARA)
    expect(crs.parse(crs.format(quantised, { style: 'projected' }))).toEqual(quantised)
  })

  it('accepts a bare space-separated pair, easting first', () => {
    const expected = crs.quantise(ANKARA)
    const [easting, northing] = crs.working.forward(expected)

    const parsed = crs.parse(`${easting.toFixed(3)} ${northing.toFixed(3)}`)
    expect(parsed).toBeDefined()
    expect(crs.distance(parsed!, expected)).toBeLessThan(0.001)
  })

  it('honours Y=/X= labels in either order', () => {
    const forwards = crs.parse('Y=743638.711  X=4425647.725')
    const backwards = crs.parse('X=4425647.725  Y=743638.711')

    expect(forwards).toBeDefined()
    expect(backwards).toEqual(forwards)
    // The labelled pair really is the Ankara point, i.e. Y was read as the easting.
    expect(crs.distance(forwards!, ANKARA)).toBeLessThan(0.01)
  })

  it('accepts the Turkish comma decimal separator', () => {
    const spaced = crs.parse('743638,711 4425647,725')
    const semicolon = crs.parse('743638,711;4425647,725')
    const commaPaired = crs.parse('743638,711,4425647,725')

    expect(spaced).toBeDefined()
    expect(semicolon).toEqual(spaced)
    expect(commaPaired).toEqual(spaced)
    expect(crs.distance(spaced!, ANKARA)).toBeLessThan(0.01)
  })

  it('reads a comma as a decimal point when whitespace separates the pair', () => {
    // '1,5 2,5' is (1.5, 2.5) — not (1, 5) and (2, 5).
    const parsed = crs.parse('500001,5 4000002,5')
    expect(parsed).toBeDefined()

    const [easting, northing] = crs.working.forward(parsed!)
    expect(easting).toBeCloseTo(500001.5, 2)
    expect(northing).toBeCloseTo(4000002.5, 2)
  })

  it('accepts a dotted pair separated by a comma', () => {
    const parsed = crs.parse('743638.711,4425647.725')
    expect(parsed).toBeDefined()
    expect(crs.distance(parsed!, ANKARA)).toBeLessThan(0.01)
  })

  it.each([
    ['458123,456', 'one comma, no space: one Turkish decimal or two integers?'],
    ['458123', 'a single number is not a coordinate'],
    ['458.123,456,4425647.725', 'a thousands separator is a guess we refuse to make'],
    ['458123.456 4425647.725 12.5', 'three numbers'],
    ['Y=458123.456', 'only half a pair'],
    ['', 'nothing at all'],
    ['güneybatı köşe', 'not a coordinate'],
  ])('returns undefined for ambiguous or malformed input: %s', (text) => {
    expect(crs.parse(text)).toBeUndefined()
  })
})

describe('registration and errors', () => {
  it('refuses EPSG:4326 as a working CRS, and says what to use instead', () => {
    expect(() => crsService('EPSG:4326')).toThrow(/geographic CRS/)
    expect(() => crsService('EPSG:4326')).toThrow(/EPSG:5254/)
  })

  it('names the registered systems when a code is unknown', () => {
    expect(() => crsService('EPSG:9999')).toThrow(/unknown CRS "EPSG:9999"/)
    expect(() => crsService('EPSG:9999')).toThrow(/EPSG:5254/)
  })

  it('registers a municipal grid and measures in it', () => {
    const crs = crsService()
    const local = crs.register({
      code: 'ANKARA-BB-LOCAL',
      name: 'Ankara Büyükşehir local grid (illustrative)',
      proj4:
        '+proj=tmerc +lat_0=0 +lon_0=33 +k=1 +x_0=500000 +y_0=0 ' +
        '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
      unit: 'metre',
      precision: 0.001,
      bounds: [31.5, 35.5, 34.5, 42.5],
    })

    expect(local.code).toBe('ANKARA-BB-LOCAL')
    expect(crs.list()).toContain('ANKARA-BB-LOCAL')

    crs.setWorking('ANKARA-BB-LOCAL')
    expect(crs.area(planarRectangle(crs.working, ANKARA, 50, 40))).toBeCloseTo(2000, 3)
  })

  it('accepts an identical re-registration but refuses a conflicting one', () => {
    const crs = crsService()
    const definition = {
      code: 'LOCAL-A',
      name: 'Local A',
      proj4:
        '+proj=tmerc +lat_0=0 +lon_0=33 +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs',
      unit: 'metre',
      precision: 0.001,
    } as const

    expect(crs.register(definition).code).toBe('LOCAL-A')
    expect(crs.register(definition).code).toBe('LOCAL-A')

    expect(() =>
      crs.register({ ...definition, proj4: definition.proj4.replace('lon_0=33', 'lon_0=30') }),
    ).toThrow(/already registered with a different definition/)
  })

  it('refuses to register a geographic CRS as a plane', () => {
    const crs = crsService()
    expect(() =>
      crs.register({
        code: 'MY-4326',
        name: 'Geographic',
        proj4: '+proj=longlat +datum=WGS84 +no_defs',
        unit: 'metre',
        precision: 0.001,
      }),
    ).toThrow(/geographic/)
  })

  it('refuses a proj4 definition that does not project', () => {
    const crs = crsService()
    expect(() =>
      crs.register({
        code: 'BROKEN',
        name: 'Broken',
        proj4: '+proj=not_a_projection +units=m +no_defs',
        unit: 'metre',
        precision: 0.001,
      }),
    ).toThrow(/BROKEN/)
  })

  it('refuses a non-metre unit — the plane is metres end to end, and only CrsService ever knew otherwise', () => {
    const crs = crsService()
    expect(() =>
      crs.register({
        code: 'CA-SPCS-III-FT',
        name: 'NAD83 California zone III (ftUS)',
        proj4:
          '+proj=lcc +lat_1=38.43 +lat_2=37.06 +lat_0=36.5 +lon_0=-120.5 +x_0=2000000 ' +
          '+y_0=500000 +ellps=GRS80 +units=us-ft +no_defs',
        // A JS caller (or an `as never`) is the only way to reach this now — the type is
        // `'metre'` — but the runtime guard must still catch it.
        unit: 'foot' as never,
        precision: 0.001,
      }),
    ).toThrow(/metre/i)
  })
})

describe('setWorking / onChange', () => {
  it('notifies subscribers when the working CRS changes', () => {
    const crs = crsService('EPSG:5254')
    let fired = 0
    crs.onChange(() => fired++)

    crs.setWorking('EPSG:5255')
    expect(fired).toBe(1)
    expect(crs.working.code).toBe('EPSG:5255')
  })

  it('does not fire when set to the CRS already active — a rebuild is not free', () => {
    const crs = crsService('EPSG:5254')
    let fired = 0
    crs.onChange(() => fired++)

    crs.setWorking('EPSG:5254')
    expect(fired).toBe(0)
  })

  it('stops notifying once the subscription is disposed', () => {
    const crs = crsService('EPSG:5254')
    let fired = 0
    const sub = crs.onChange(() => fired++)

    crs.setWorking('EPSG:5255')
    sub.dispose()
    crs.setWorking('EPSG:5254')

    expect(fired).toBe(1)
  })

  it('survives a handler that throws — the others still run', () => {
    const crs = crsService('EPSG:5254')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    crs.onChange(() => {
      throw new Error('boom')
    })
    crs.onChange(() => seen.push(crs.working.code))

    crs.setWorking('EPSG:5255')

    expect(seen).toEqual(['EPSG:5255'])
    error.mockRestore()
  })
})

describe('bboxAround', () => {
  it('returns a finite, world-clamped box at a huge radius instead of throwing', () => {
    // Collection.nearest() doubles its search radius up to 20 000 km when the nearest
    // feature is far. In a TM belt that radius runs off the projectable domain; the old
    // four-corner box inverse-projected to NaN and threw (after returning a box that did
    // not even contain the query point).
    const crs = crsService('EPSG:5254') // TUREF / TM30
    const [w, s, e, n] = bboxAround(crs, ANKARA, 20_000_000)

    expect([w, s, e, n].every((v) => Number.isFinite(v))).toBe(true)
    expect(w).toBeGreaterThanOrEqual(-180)
    expect(e).toBeLessThanOrEqual(180)
    expect(s).toBeGreaterThanOrEqual(-90)
    expect(n).toBeLessThanOrEqual(90)
    // Still contains the query point.
    expect(w).toBeLessThanOrEqual(ANKARA[0])
    expect(e).toBeGreaterThanOrEqual(ANKARA[0])
    expect(s).toBeLessThanOrEqual(ANKARA[1])
    expect(n).toBeGreaterThanOrEqual(ANKARA[1])
  })

  it('widens to the CRS bounds in the finite-garbage band, where samples never trip the NaN guard', () => {
    // At ~8 000 km a TM inverse returns finite-but-meaningless lng/lat — no throw, no NaN
    // (verified: every rim sample lands near 95°E). Trusting those samples would shrink the
    // box below the true disc without ever failing the finiteness check, so the radius guard
    // treats a disc this large as spilled and boxes it by the belt's declared bounds instead.
    const crs = crsService('EPSG:5254') // TUREF / TM30
    const plane = crs.working
    const bounds = plane.bounds!
    const [w, s, e, n] = bboxAround(crs, ANKARA, 8_000_000)

    // A genuine superset of the belt's validity extent, not the arbitrary AABB of garbage.
    expect(w).toBeLessThanOrEqual(bounds[0])
    expect(s).toBeLessThanOrEqual(bounds[1])
    expect(e).toBeGreaterThanOrEqual(bounds[2])
    expect(n).toBeGreaterThanOrEqual(bounds[3])
    // And no wider than bounds ∪ the query point — proof the garbage rim samples were
    // discarded, not folded in. Pre-guard, a rim sample near 95°E blew `e` far past this.
    expect(e).toBeLessThanOrEqual(Math.max(bounds[2], ANKARA[0]) + 1e-6)
    expect(w).toBeGreaterThanOrEqual(Math.min(bounds[0], ANKARA[0]) - 1e-6)
    expect(n).toBeLessThanOrEqual(Math.max(bounds[3], ANKARA[1]) + 1e-6)
    expect(s).toBeGreaterThanOrEqual(Math.min(bounds[1], ANKARA[1]) - 1e-6)
  })

  it('is a genuine superset of the metric disc — every point R metres out is inside', () => {
    const crs = crsService('EPSG:5254')
    const plane = crs.working
    const R = 5000
    const [cx, cy] = plane.forward(ANKARA)
    const [w, s, e, n] = bboxAround(crs, ANKARA, R)

    // Sample the true metric rim densely; the box must contain all of it. The old
    // four-corner box misses the belt's edge-midpoint bulge and drops rim points here.
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * 2 * Math.PI
      const [lng, lat] = plane.inverse([cx + R * Math.cos(a), cy + R * Math.sin(a)])
      expect(lng).toBeGreaterThanOrEqual(w)
      expect(lng).toBeLessThanOrEqual(e)
      expect(lat).toBeGreaterThanOrEqual(s)
      expect(lat).toBeLessThanOrEqual(n)
    }
  })
})
