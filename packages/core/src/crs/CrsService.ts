import proj4 from 'proj4'
import type { Geometry, Position } from 'geojson'

import type { Disposable, LngLat, ProjectedXY } from '../types/common.js'
import type { CrsCode, CrsService, ProjectedCrs } from '../types/crs.js'
import type { CrsConfig } from '../types/config.js'

import {
  BUILTIN_CRS,
  DEFAULT_PRECISION,
  GEOGRAPHIC_CODES,
  WGS84_PROJ4,
  type CrsSpec,
} from './registry.js'
import {
  distanceXY,
  gridBearing,
  decimalsForGrid,
  pathLength,
  polygonArea,
  polygonPerimeter,
  snapToGrid,
  snapXYToGrid,
} from './planar.js'

/** A spec plus the quantisation grid it will be materialised with. */
type CrsDefinition = CrsSpec & { readonly precision: number }

/**
 * The CRS service — the reason cadastral numbers come out right.
 *
 * Everything in BlaeuMap is stored in WGS84 lng/lat (core invariant 3), and
 * nothing survey-grade is *computed* there. Each measurement below follows the
 * same three steps: project into the working plane, do honest planar maths in
 * metres, and — where a coordinate comes back — unproject. The projection
 * sandwich is not a style; it is the difference between an area a land registry
 * accepts and one that is quietly a few square metres out.
 *
 * The class is deliberately boring. All the danger in coordinate handling is in
 * the places where a unit or a datum changes silently, so this file makes every
 * one of those places explicit and refuses the ambiguous ones.
 */
export class BlaeuCrsService implements CrsService {
  readonly #config: CrsConfig
  /** Registered definitions, keyed by normalised code. */
  readonly #defs = new Map<string, CrsDefinition>()
  /**
   * Materialised CRSs, each holding a proj4 converter built exactly once.
   *
   * Building a converter parses a proj4 string and constructs a projection
   * object. `InteractionContext.xy` calls `forward` on every `pointermove` — up
   * to 120 times a second — so doing that work per call would be a real, visible
   * cost, and one that only shows up under a finger on a phone.
   */
  readonly #cache = new Map<string, ProjectedCrs>()
  #working: ProjectedCrs
  #handlers: (() => void)[] = []

  constructor(config: CrsConfig) {
    this.#config = config

    const precision = gridFromDecimalPlaces(config.precision)
    for (const spec of BUILTIN_CRS) {
      this.#defs.set(normalise(spec.code), { ...spec, precision })
    }

    this.#working = this.#require(config.working)
  }

  get working(): ProjectedCrs {
    return this.#working
  }

  setWorking(code: CrsCode): void {
    const next = this.#require(code)
    // Same plane, nothing derived from it is stale — do not fire, so a rebuild of the
    // whole topology index does not happen on a no-op call.
    if (next === this.#working) return
    this.#working = next
    for (const handler of [...this.#handlers]) {
      try {
        handler()
      } catch (err) {
        // One stale-index rebuild throwing must not stop the others running — a
        // half-updated set of derived indexes is worse than a logged error.
        console.error('[blaeu] a crs onChange handler threw:', err)
      }
    }
  }

  onChange(handler: () => void): Disposable {
    this.#handlers.push(handler)
    return {
      dispose: () => {
        const i = this.#handlers.indexOf(handler)
        if (i >= 0) this.#handlers.splice(i, 1)
      },
    }
  }

  get(code: CrsCode): ProjectedCrs | undefined {
    const key = normalise(code)
    const cached = this.#cache.get(key)
    if (cached) return cached

    const def = this.#defs.get(key)
    if (!def) return undefined

    const crs = materialise(def)
    this.#cache.set(key, crs)
    return crs
  }

  /**
   * Register a custom CRS — a municipal grid, a utility's local system, a project
   * plane defined by a client.
   *
   * The definition is round-trip probed here rather than on first use. A bad proj4
   * string that fails at `register()` names itself; the same string failing on the
   * first `pointermove` of a drag surfaces as a vertex jumping to the Gulf of
   * Guinea, and takes an afternoon to trace.
   */
  register(crs: CrsDefinition): ProjectedCrs {
    const key = normalise(crs.code)

    if (isGeographic(crs.code) || isLongLat(crs.proj4)) {
      throw new Error(
        `[blaeu] cannot register "${crs.code}" as a projected CRS: it is geographic ` +
          `(lng/lat degrees), and every survey-grade measurement in BlaeuMap needs a plane in ` +
          `metres. Register a projected system instead — e.g. EPSG:5254 (TUREF / TM30).`,
      )
    }
    if (crs.unit !== 'metre') {
      // Metres are load-bearing: the topology grid, snap tolerances, the JSTS precision
      // model and buffer distances all treat a projected coordinate as metres, and only
      // this service ever applied a unit scale — so a foot CRS produced correct areas
      // here and wrong ones everywhere else. Reject it rather than half-honour it.
      throw new Error(
        `[blaeu] cannot register "${crs.code}" with unit "${String(crs.unit)}": BlaeuMap works in ` +
          `metres end to end. Supply a metre-based proj4 (\`+units=m\`), or pre-convert the grid to metres.`,
      )
    }
    if (!(crs.precision > 0) || !Number.isFinite(crs.precision)) {
      throw new Error(
        `[blaeu] CRS "${crs.code}" has precision ${String(crs.precision)}. It must be the ` +
          `quantisation grid in metres — 0.001 for millimetres, which is what cadastre wants.`,
      )
    }

    const existing = this.#defs.get(key)
    if (existing) {
      // Re-registering the identical definition is how two presets that both need
      // the same municipal grid compose without knowing about each other. Changing
      // a definition out from under geometry that was already quantised to it is
      // something else entirely, and is refused.
      if (
        existing.proj4 === crs.proj4 &&
        existing.unit === crs.unit &&
        existing.precision === crs.precision
      ) {
        return this.get(crs.code)!
      }
      throw new Error(
        `[blaeu] CRS "${crs.code}" is already registered with a different definition. ` +
          `Redefining a code would silently change every coordinate already measured against ` +
          `it. Choose a distinct code (e.g. "${crs.code}-LOCAL") instead.`,
      )
    }

    const def: CrsDefinition = { ...crs }
    const materialised = materialise(def)

    this.#defs.set(key, def)
    this.#cache.set(key, materialised)
    return materialised
  }

  list(): readonly CrsCode[] {
    return [...this.#defs.values()].map((def) => def.code)
  }

  /**
   * Is this coordinate inside the CRS's declared validity extent?
   *
   * This is a *check*, not a *warning*: it is not called from `forward`, because
   * `forward` runs at pointer frequency and a warning per pointermove would be
   * both a cost and a torrent. Validation rules and importers call it once per
   * feature, which is where the question actually matters — "this parcel is in the
   * TM33 belt but you are measuring it in TM30" is worth saying once, loudly.
   */
  withinBounds(lngLat: LngLat, code?: CrsCode): boolean {
    const crs = code === undefined ? this.#working : this.get(code)
    if (!crs?.bounds) return true

    const [west, south, east, north] = crs.bounds
    const [lng, lat] = lngLat
    return lng >= west && lng <= east && lat >= south && lat <= north
  }

  /* --- measurement: the projection sandwich, once per operation --- */

  /**
   * Planar area in m², in the working CRS.
   *
   * Not `@turf/area`. Turf's area is spherical, and on a 2 000 m² parcel at
   * Turkish latitudes the two answers differ by 0.5–2.5 m² depending on where the
   * parcel sits in its belt — enough to move a boundary in a dispute, and small
   * enough that nobody notices until one does. The land registry's number is the
   * one computed from the projected coordinates on the plan, which is this one.
   * `CrsService.test.ts` measures the discrepancy rather than asserting it exists.
   */
  area(geometry: Geometry): number {
    const plane = this.#working

    switch (geometry.type) {
      case 'Polygon':
        return polygonArea(projectRings(plane, geometry.coordinates))
      case 'MultiPolygon':
        return geometry.coordinates.reduce(
          (total, rings) => total + polygonArea(projectRings(plane, rings)),
          0,
        )
      case 'GeometryCollection':
        return geometry.geometries.reduce((total, part) => total + this.area(part), 0)
      case 'Point':
      case 'MultiPoint':
      case 'LineString':
      case 'MultiLineString':
        return 0
    }
  }

  /** Planar length (or perimeter, for areal geometry) in metres, in the working CRS. */
  length(geometry: Geometry): number {
    const plane = this.#working

    switch (geometry.type) {
      case 'LineString':
        return pathLength(projectPath(plane, geometry.coordinates))
      case 'MultiLineString':
        return geometry.coordinates.reduce(
          (total, line) => total + pathLength(projectPath(plane, line)),
          0,
        )
      // A polygon's "length" is its perimeter, holes included: a courtyard has a
      // wall too, and a fencing contractor is going to bill for it.
      case 'Polygon':
        return polygonPerimeter(projectRings(plane, geometry.coordinates))
      case 'MultiPolygon':
        return geometry.coordinates.reduce(
          (total, rings) => total + polygonPerimeter(projectRings(plane, rings)),
          0,
        )
      case 'GeometryCollection':
        return geometry.geometries.reduce((total, part) => total + this.length(part), 0)
      case 'Point':
      case 'MultiPoint':
        return 0
    }
  }

  /** Planar distance in metres — the distance on the plan, not the great circle. */
  distance(a: LngLat, b: LngLat): number {
    const plane = this.#working
    return distanceXY(plane.forward(a), plane.forward(b))
  }

  /** Grid bearing in degrees, clockwise from grid north. See `planar.gridBearing`. */
  bearing(a: LngLat, b: LngLat): number {
    const plane = this.#working
    return gridBearing(plane.forward(a), plane.forward(b))
  }

  /**
   * Snap a coordinate to the working CRS's precision grid — in **metres**, on the
   * plane, never in degrees.
   *
   * The whole method is three lines and exists to make one mistake impossible. The
   * tempting version rounds the lng/lat to `precision` decimal places, and it is
   * catastrophic: three decimal places of longitude is ~85 m at Turkish latitudes,
   * not 1 mm. Rounding in degrees would silently move every corner of every parcel
   * by up to a house. Going through the plane means the grid is a real, isotropic
   * millimetre everywhere on Earth.
   */
  quantise(lngLat: LngLat): LngLat {
    const plane = this.#working
    return plane.inverse(snapXYToGrid(plane.forward(lngLat), plane.precision))
  }

  format(lngLat: LngLat, options?: { readonly style?: 'projected' | 'dms' | 'decimal' }): string {
    const style = options?.style ?? this.#config.display
    const plane = this.#working

    switch (style) {
      case 'projected': {
        const places = displayPlaces(plane.precision)
        const [easting, northing] = plane.forward(lngLat)
        // Turkish (and wider Gauss-Krüger) convention: **Y is the easting and X is
        // the northing** — the transpose of the schoolroom x/y, and the single most
        // reliable way to get a parcel plotted sideways. The labels are emitted so
        // the reader never has to infer which is which from magnitude.
        return `Y=${easting.toFixed(places)}  X=${northing.toFixed(places)}`
      }
      case 'dms':
        // Display and interop only. DMS is not the survey readout: one hundredth of
        // an arcsecond is ~0.3 m, so a DMS string cannot even express the grid the
        // rest of this file is careful about. Use 'projected' for anything measured.
        return `${toDms(lngLat[1], 'N', 'S')}  ${toDms(lngLat[0], 'E', 'W')}`
      case 'decimal':
        // lng then lat — GeoJSON order, store order, MapLibre order (see LngLat).
        return `${lngLat[0].toFixed(7)}, ${lngLat[1].toFixed(7)}`
    }
  }

  /**
   * Parse a surveyor-typed coordinate in the working CRS back to lng/lat.
   *
   * Accepts what people actually type: `458123.456 4421987.123`, with optional
   * `Y=`/`X=` labels in either order, separated by whitespace, a comma or a
   * semicolon — and with a comma as the **decimal** separator, because the Turkish
   * locale writes `458123,456`.
   *
   * Those last two collide, and the collision is real: in `1,5 2,5` the commas are
   * decimal points, while in `458123.456,4421987.123` the comma separates the
   * pair. The rule chosen, in order:
   *
   * 1. `Y=`/`X=` labels, if present, decide everything — they are unambiguous, and
   *    are the escape hatch when nothing else is.
   * 2. A semicolon, if present, separates the pair; every comma is a decimal point.
   * 3. Otherwise, whitespace, if present, separates the pair; every comma is a
   *    decimal point. (`1,5 2,5` → 1.5, 2.5.)
   * 4. Otherwise the string is commas only. Four groups mean two Turkish decimals
   *    (`458123,456,4421987,123`). Two groups mean a comma-separated pair *only if
   *    a dot appears somewhere* (`458123.456,4421987.123`).
   * 5. Anything left is genuinely ambiguous — `458123,456` is one number or two —
   *    and returns `undefined`. Guessing here would be a silent 4 km error; the
   *    caller should ask the user to type a space or use labels.
   *
   * A number may carry at most one separator, so `458.123,456` (European thousands
   * grouping) is rejected rather than interpreted. Thousands separators in typed
   * coordinates are not worth the risk of getting one wrong.
   */
  parse(text: string): LngLat | undefined {
    const pair = parseProjectedPair(text)
    if (!pair) return undefined

    const plane = this.#working
    const grid = plane.precision
    const xy: ProjectedXY = [snapToGrid(pair[0], grid), snapToGrid(pair[1], grid)]

    const lngLat = plane.inverse(xy)
    if (!Number.isFinite(lngLat[0]) || !Number.isFinite(lngLat[1])) return undefined
    return lngLat
  }

  /** `get`, but a miss is fatal and says what to do about it. */
  #require(code: CrsCode): ProjectedCrs {
    const crs = this.get(code)
    if (crs) return crs

    if (isGeographic(code)) {
      throw new Error(
        `[blaeu] "${code}" is a geographic CRS (degrees), not a plane, so it cannot be the ` +
          `working CRS: area, length and offsets in BlaeuMap are planar and in metres, and ` +
          `degrees have neither property. Use a projected CRS — EPSG:5254 (TUREF / TM30) for ` +
          `Türkiye, or EPSG:3857 for a general-purpose map. Coordinates stay WGS84 either way; ` +
          `only the measuring plane changes.`,
      )
    }
    throw new Error(
      `[blaeu] unknown CRS "${code}". Registered: ${this.list().join(', ')}. ` +
        `Register a custom system with map.crs.register({ code, name, proj4, unit, precision }).`,
    )
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Codes are matched case-insensitively and whitespace-trimmed, so `'epsg:5254'`
 * and `'EPSG:5254 '` find the same system. The original spelling is what `list()`
 * reports back.
 */
function normalise(code: CrsCode): string {
  return code.trim().toUpperCase()
}

function isGeographic(code: CrsCode): boolean {
  const key = normalise(code)
  return GEOGRAPHIC_CODES.some((geographic) => normalise(geographic) === key)
}

function isLongLat(projString: string): boolean {
  return /\+proj\s*=\s*longlat\b/i.test(projString)
}

/**
 * `CrsConfig.precision` is **decimal places**, not a grid size — 3 means
 * millimetres. The two are easy to confuse and the confusion is silent, so a
 * value that looks like a grid size (0.001) is caught here with the one message
 * that resolves it, rather than becoming a ~1 m quantisation grid that nothing
 * downstream can distinguish from correct behaviour.
 */
function gridFromDecimalPlaces(places: number): number {
  if (!Number.isInteger(places) || places < 0 || places > 12) {
    const hint =
      places > 0 && places < 1
        ? ` That looks like a grid size in metres; ${String(places)} m would be the grid for ` +
          `precision ${String(Math.round(-Math.log10(places)))}.`
        : ''
    throw new Error(
      `[blaeu] crs.precision must be a whole number of decimal places in the working CRS's ` +
        `unit (3 = millimetres), but got ${String(places)}.${hint}`,
    )
  }
  return 10 ** -places
}

/** Decimal places to print, given a grid. Falls back to the millimetre default. */
function displayPlaces(grid: number): number {
  return decimalsForGrid(grid) ?? decimalsForGrid(DEFAULT_PRECISION)!
}

function materialise(def: CrsDefinition): ProjectedCrs {
  const converter = buildConverter(def)

  const crs: ProjectedCrs = {
    code: def.code,
    name: def.name,
    proj4: def.proj4,
    unit: def.unit,
    ...(def.bounds ? { bounds: def.bounds } : {}),
    precision: def.precision,

    forward(lngLat: LngLat): ProjectedXY {
      const out = converter.forward([lngLat[0], lngLat[1]])
      const x = out[0]
      const y = out[1]
      // A NaN coordinate is the worst failure mode in the library: it renders as
      // "nothing there" rather than as an error, and the geometry it belongs to
      // simply disappears. Two comparisons on a pointermove is a price worth
      // paying to turn that into a stack trace.
      if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(
          `[blaeu] ${def.code}: cannot project [${String(lngLat[0])}, ${String(lngLat[1])}]. ` +
            `Check the coordinate is WGS84 lng/lat (in that order) and inside the CRS's extent.`,
        )
      }
      return [x, y]
    },

    inverse(xy: ProjectedXY): LngLat {
      const out = converter.inverse([xy[0], xy[1]])
      const lng = out[0]
      const lat = out[1]
      if (
        lng === undefined ||
        lat === undefined ||
        !Number.isFinite(lng) ||
        !Number.isFinite(lat)
      ) {
        throw new Error(
          `[blaeu] ${def.code}: cannot unproject [${String(xy[0])}, ${String(xy[1])}]. ` +
            `Check the coordinate is in ${def.code}'s ${def.unit}s, not in degrees.`,
        )
      }
      return [lng, lat]
    },
  }

  probe(crs)
  return crs
}

function buildConverter(def: CrsDefinition) {
  try {
    return proj4(WGS84_PROJ4, def.proj4)
  } catch (err) {
    throw new Error(
      `[blaeu] CRS "${def.code}" has a proj4 definition that proj4 cannot parse: ` +
        `"${def.proj4}" (${String(err)}). Copy the definition from epsg.io, or from the ` +
        `authority that issued the grid.`,
    )
  }
}

/**
 * Round-trip a point through a freshly built CRS to prove it actually projects.
 *
 * proj4 does not reliably throw on a malformed definition — it can return a
 * converter that produces `NaN` or `Infinity` on first use. That failure would
 * otherwise land on a user's first click, on a coordinate they chose, which makes
 * it look like a data problem rather than a configuration one.
 */
function probe(crs: ProjectedCrs): void {
  const centre: LngLat = crs.bounds
    ? [(crs.bounds[0] + crs.bounds[2]) / 2, (crs.bounds[1] + crs.bounds[3]) / 2]
    : [0, 0]

  const back = crs.inverse(crs.forward(centre))
  // Generous: this is a smoke test for "is this a working projection at all", not
  // a precision assertion. A definition that round-trips a whole degree off is
  // broken in a way no tolerance forgives.
  if (Math.abs(back[0] - centre[0]) > 1e-6 || Math.abs(back[1] - centre[1]) > 1e-6) {
    throw new Error(
      `[blaeu] CRS "${crs.code}" does not round-trip: [${String(centre[0])}, ` +
        `${String(centre[1])}] came back as [${String(back[0])}, ${String(back[1])}]. ` +
        `Its proj4 definition is wrong, and every coordinate measured against it would be too.`,
    )
  }
}

function toXY(plane: ProjectedCrs, position: Position): ProjectedXY {
  const lng = position[0]
  const lat = position[1]
  if (lng === undefined || lat === undefined) {
    throw new Error(
      `[blaeu] malformed position [${position.join(', ')}]: a GeoJSON position needs at ` +
        `least [lng, lat]. Measuring around it would produce a plausible, wrong number.`,
    )
  }
  return plane.forward([lng, lat])
}

function projectPath(plane: ProjectedCrs, path: readonly Position[]): ProjectedXY[] {
  return path.map((position) => toXY(plane, position))
}

function projectRings(plane: ProjectedCrs, rings: readonly Position[][]): ProjectedXY[][] {
  return rings.map((ring) => projectPath(plane, ring))
}

function toDms(value: number, positive: string, negative: string): string {
  const hemisphere = value < 0 ? negative : positive
  const absolute = Math.abs(value)

  let degrees = Math.floor(absolute)
  let minutes = Math.floor((absolute - degrees) * 60)
  let seconds = Number((((absolute - degrees) * 60 - minutes) * 60).toFixed(3))

  // Carry, because 59.9999" rounds to 60.000" and "39°55'60.000\"N" is not a
  // coordinate anyone wants to read.
  if (seconds >= 60) {
    seconds -= 60
    minutes += 1
  }
  if (minutes >= 60) {
    minutes -= 60
    degrees += 1
  }

  const mm = String(minutes).padStart(2, '0')
  const ss = seconds.toFixed(3).padStart(6, '0')
  return `${degrees}°${mm}'${ss}"${hemisphere}`
}

/* ---------------------------------------------------------------- parsing */

/** One number: at most one separator, comma or dot, either meaning "decimal point". */
function parseNumber(token: string): number | undefined {
  const trimmed = token.trim()
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(trimmed)) return undefined

  const value = Number(trimmed.replace(',', '.'))
  return Number.isFinite(value) ? value : undefined
}

const LABELLED = /([xy])\s*[=:]\s*([+-]?[\d.,]+)/gi

/** `[easting, northing]` in the working CRS's unit, or `undefined` if ambiguous. */
function parseProjectedPair(text: string): readonly [number, number] | undefined {
  const raw = text.trim()
  if (raw.length === 0) return undefined

  const labelled = [...raw.matchAll(LABELLED)]
  if (labelled.length > 0) {
    // Turkish convention: Y is the easting, X is the northing. Because the labels
    // say which is which, `X=4421987.123 Y=458123.456` parses correctly even
    // though it is written back-to-front.
    if (labelled.length !== 2) return undefined

    const values = new Map<string, number | undefined>()
    for (const match of labelled) {
      values.set(match[1]!.toLowerCase(), parseNumber(match[2]!))
    }
    const easting = values.get('y')
    const northing = values.get('x')
    if (easting === undefined || northing === undefined) return undefined
    return [easting, northing]
  }

  const tokens = splitPair(raw)
  if (!tokens) return undefined

  const easting = parseNumber(tokens[0])
  const northing = parseNumber(tokens[1])
  if (easting === undefined || northing === undefined) return undefined

  // Unlabelled input is read as easting-then-northing: it is the order a Turkish
  // surveyor types, and the order `format()` emits, so `parse(format(x))` closes.
  return [easting, northing]
}

function splitPair(raw: string): readonly [string, string] | undefined {
  if (raw.includes(';')) {
    const parts = raw
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    return parts.length === 2 ? [parts[0]!, parts[1]!] : undefined
  }

  if (/\s/.test(raw)) {
    const parts = raw
      .split(/\s+/)
      // A trailing pair-separator is normal ('458123,456, 4421987,123'); strip it
      // and the token is still a number, with its decimal comma intact.
      .map((part) => part.replace(/^[,;]+|[,;]+$/g, ''))
      .filter((part) => part.length > 0)
    return parts.length === 2 ? [parts[0]!, parts[1]!] : undefined
  }

  const groups = raw.split(',')
  if (groups.length === 4) {
    // '458123,456,4421987,123' — Turkish decimal commas with a comma between the
    // pair. Four groups can only be read one way, so it is safe.
    return [`${groups[0]!}.${groups[1]!}`, `${groups[2]!}.${groups[3]!}`]
  }
  if (groups.length === 2 && raw.includes('.')) {
    // A dot is present, so the dots are the decimal points and the comma is not.
    return [groups[0]!, groups[1]!]
  }

  // '458123,456' — one number (Turkish decimal) or two (comma-separated)? There is
  // no honest way to tell, and a wrong guess is a 4 km error. Refuse.
  return undefined
}
