/**
 * A real projected CRS for the store's unit tests.
 *
 * Test-only, and deliberately *not* a mock: the store's whole reason for existing
 * is that coordinates get snapped to a metric grid before anything else touches
 * them, so testing it against a fake projection with a made-up `quantise` would
 * test nothing. This is EPSG:5254 (TUREF / TM30) through proj4 — the plane a
 * Turkish land registry actually works in — with a 1 mm grid.
 *
 * It lives beside the store rather than in `testing/` because it is a fixture for
 * *these* tests, not part of the public test harness.
 */

import proj4 from 'proj4'

import type { Geometry, Position } from 'geojson'
import type { Disposable, LngLat, ProjectedXY } from '../types/common.js'
import type { CrsCode, CrsService, ProjectedCrs } from '../types/crs.js'
import { planarDistance, toLngLat } from '../utils/geometry.js'

const WGS84 = '+proj=longlat +datum=WGS84 +no_defs'
const TM30 = '+proj=tmerc +lat_0=0 +lon_0=30 +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs'

export function createTestCrs(precisionMetres = 0.001): CrsService {
  const converter = proj4(WGS84, TM30)

  const working: ProjectedCrs = {
    code: 'EPSG:5254',
    name: 'TUREF / TM30',
    proj4: TM30,
    unit: 'metre',
    precision: precisionMetres,
    forward(lngLat: LngLat): ProjectedXY {
      const [x, y] = converter.forward<number[]>([lngLat[0], lngLat[1]])
      return [x!, y!]
    },
    inverse(xy: ProjectedXY): LngLat {
      const [lng, lat] = converter.inverse<number[]>([xy[0], xy[1]])
      return [lng!, lat!]
    },
  }

  const quantise = (lngLat: LngLat): LngLat => {
    const [x, y] = working.forward(lngLat)
    const grid = working.precision
    return working.inverse([Math.round(x / grid) * grid, Math.round(y / grid) * grid])
  }

  const pathLength = (path: readonly Position[]): number => {
    const xy = path.map((p) => working.forward(toLngLat(p)))
    let total = 0
    for (let i = 0; i < xy.length - 1; i++) total += planarDistance(xy[i]!, xy[i + 1]!)
    return total
  }

  return {
    working,
    quantise,

    setWorking(): void {
      throw new Error('test CRS is fixed to EPSG:5254')
    },

    // Fixed CRS, so nothing ever changes; nothing to unsubscribe.
    onChange(): Disposable {
      return { dispose: () => {} }
    },
    get(code: CrsCode): ProjectedCrs | undefined {
      return code === working.code ? working : undefined
    },
    register(): ProjectedCrs {
      throw new Error('test CRS does not support registration')
    },
    list(): readonly CrsCode[] {
      return [working.code]
    },

    area(geometry: Geometry): number {
      if (geometry.type !== 'Polygon') return 0
      const ring = (geometry.coordinates[0] ?? []).map((p) => working.forward(toLngLat(p)))
      let sum = 0
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!
        const b = ring[(i + 1) % ring.length]!
        sum += a[0] * b[1] - b[0] * a[1]
      }
      return Math.abs(sum) / 2
    },
    length(geometry: Geometry): number {
      if (geometry.type === 'LineString') return pathLength(geometry.coordinates)
      if (geometry.type === 'Polygon') {
        return geometry.coordinates.reduce((sum, ring) => sum + pathLength(ring), 0)
      }
      return 0
    },
    distance(a: LngLat, b: LngLat): number {
      return planarDistance(working.forward(a), working.forward(b))
    },
    bearing(a: LngLat, b: LngLat): number {
      const [ax, ay] = working.forward(a)
      const [bx, by] = working.forward(b)
      return ((Math.atan2(bx - ax, by - ay) * 180) / Math.PI + 360) % 360
    },
    format(lngLat: LngLat): string {
      const [x, y] = working.forward(lngLat)
      return `Y=${x.toFixed(3)} X=${y.toFixed(3)}`
    },
    parse(): LngLat | undefined {
      return undefined
    },
  }
}

/** Moves a lng/lat by an exact offset **in projected metres** — the only honest way to say "0.4 mm east". */
export function offsetMetres(crs: CrsService, point: LngLat, dx: number, dy: number): LngLat {
  const [x, y] = crs.working.forward(point)
  return crs.working.inverse([x + dx, y + dy])
}

/** Places a point exactly on the precision grid, so a test can then straddle a cell boundary on purpose. */
export function onGrid(crs: CrsService, point: LngLat): LngLat {
  return crs.quantise(point)
}
