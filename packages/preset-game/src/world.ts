import type { CrsSpec, LngLat } from '@blaeu/core'
import type { ResolvedGameOptions, WorldBbox, WorldTransform, WorldXY } from './types.js'

/**
 * The world plane: a game world's CRS, and the most interesting file in this package.
 *
 * ## The problem
 *
 * A game world has no geodesy. It is a plane in arbitrary units — "the chest is at
 * (128, 96)" — with no datum, no ellipsoid, and no opinion about the poles. But
 * BlaeuMap's store is WGS84 lng/lat, without exception (core invariant 3), and that
 * invariant is not negotiable: it is what lets the spatial index, the topology
 * index, GeoJSON export and every plugin ever written agree on what a coordinate
 * *is*.
 *
 * ## The trick
 *
 * Register a projected CRS whose plane **is** the game world, and let the kernel's
 * existing projection sandwich do the rest. Everything survey-grade in BlaeuMap —
 * area, length, distance, quantisation, grid snapping — already runs as
 * `working.forward → planar maths → working.inverse`. Make `working` the game
 * plane and all of it works, unchanged, in world units. The snap engine's grid
 * provider does not know it is snapping a tilemap. `crs.area()` returns tiles².
 *
 * The projection is `+proj=eqc` (equidistant cylindrical) on a **sphere of our own
 * choosing**:
 *
 *     x = R · λ,  y = R · φ        (λ, φ in radians; lat_ts = 0)
 *
 * which is exactly linear in degrees. Choose `R = unitsPerDegree · 180/π` and the
 * map from degrees to world units is a pure scale:
 *
 *     x = unitsPerDegree · lng,  y = unitsPerDegree · lat
 *
 * No trigonometry, no distortion, no scale factor that varies with latitude —
 * because there is no Earth. It is an affine identity plane wearing a proj4 string,
 * which is the only disguise the CRS abstraction requires.
 *
 * ## The limits, honestly
 *
 * 1. **The world lives in a tiny patch of the equator.** At the default scale, a
 *    4096-unit world occupies 0.04° square near [0, 0]. That is deliberate: near
 *    the equator, and small, so a `double` degree resolves ~1e-10 world units, and
 *    so nothing ever approaches the ±90° latitude where the inverse breaks.
 *    {@link assertWorldFits} refuses a world that does not.
 * 2. **The lng/lat are meaningless as geography.** A tree at world (128, 96) is
 *    "at" 0.00128°E, 0.00096°N — in the Gulf of Guinea. It is not there. Nothing in
 *    the game reads those numbers, and no basemap is drawn under them (see
 *    `theme.ts`). Export via {@link WorldTransform.toWorld}, never as raw GeoJSON,
 *    or your level file will be a lie that happens to validate.
 * 3. **It is not a real CRS and must not be published as one.** The code is
 *    `GAME:WORLD`, not an EPSG number, precisely so nobody can mistake it for one.
 */

/** The `+proj=eqc` sphere whose surface is the game plane, in world units. */
export function worldRadius(unitsPerDegree: number): number {
  return (unitsPerDegree * 180) / Math.PI
}

/**
 * The CRS definition to hand `crs.register()`.
 *
 * `bounds` is the world's own extent, expressed in 4326 — so the kernel's own
 * "you are measuring outside this CRS's validity extent" machinery reports a
 * placement outside the level, for free.
 */
export function worldCrsSpec(
  options: Pick<
    ResolvedGameOptions,
    'crsCode' | 'unitsPerDegree' | 'precision' | 'bounds' | 'gridSize'
  >,
): CrsSpec & { readonly precision: number } {
  const transform = createWorldTransform(options.unitsPerDegree)
  assertWorldFits(options.bounds, transform)

  const radius = worldRadius(options.unitsPerDegree)
  return {
    code: options.crsCode,
    name: `Game world (${options.unitsPerDegree} units/°, grid ${options.gridSize})`,
    // `+units=m` is a lie the proj4 grammar forces on us: proj4 has no notion of an
    // abstract linear unit, and every alternative it *does* understand (feet, links)
    // would be a worse lie. The unit is a world unit. Nothing downstream converts it,
    // because `unit: 'metre'` means "the CRS's linear unit, scale factor 1" to the
    // kernel — which is exactly right.
    proj4:
      `+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 ` +
      `+a=${radius} +b=${radius} +units=m +no_defs`,
    unit: 'metre',
    bounds: transform.boundsToLngLat(options.bounds),
    precision: options.precision,
  }
}

export function createWorldTransform(unitsPerDegree: number): WorldTransform {
  return {
    unitsPerDegree,

    toLngLat(xy: WorldXY): LngLat {
      return [xy[0] / unitsPerDegree, xy[1] / unitsPerDegree]
    },

    toWorld(lngLat: LngLat): WorldXY {
      return [lngLat[0] * unitsPerDegree, lngLat[1] * unitsPerDegree]
    },

    boundsToLngLat(bounds: WorldBbox): readonly [number, number, number, number] {
      const [minX, minY, maxX, maxY] = bounds
      return [
        minX / unitsPerDegree,
        minY / unitsPerDegree,
        maxX / unitsPerDegree,
        maxY / unitsPerDegree,
      ]
    },
  }
}

/**
 * The world must fit inside the patch of lng/lat where the plane is well-behaved.
 *
 * ±60° rather than ±90°: the inverse only *breaks* at the pole, but a world whose
 * corner sits at 70° latitude is a world that has been scaled wrong by two orders of
 * magnitude, and the caller would much rather hear that now than watch a MapLibre
 * camera refuse to fit its bounds later.
 */
const MAX_ABS_DEGREES = 60

export function assertWorldFits(bounds: WorldBbox, transform: WorldTransform): void {
  const [west, south, east, north] = transform.boundsToLngLat(bounds)
  const worst = Math.max(Math.abs(west), Math.abs(south), Math.abs(east), Math.abs(north))
  if (worst <= MAX_ABS_DEGREES) return

  // The scale that *would* fit, rounded up to something a human would type.
  const extent = Math.max(
    Math.abs(bounds[0]),
    Math.abs(bounds[1]),
    Math.abs(bounds[2]),
    Math.abs(bounds[3]),
  )
  const suggestion = Math.pow(10, Math.floor(Math.log10(extent / MAX_ABS_DEGREES)))

  throw new Error(
    `[preset-game] a world of [${bounds.join(', ')}] units at ${transform.unitsPerDegree} units/° maps to ` +
      `±${worst.toFixed(1)}° of lng/lat, which is outside the ±${MAX_ABS_DEGREES}° band the world plane is ` +
      `well-conditioned in. Lower unitsPerDegree (try ${suggestion}) or shrink the world. ` +
      `The store is WGS84 (core invariant 3), so a world unit must map to a degree somehow — ` +
      `this is that mapping, and it has a ceiling.`,
  )
}

/** Nearest square-grid intersection, in world units. */
export function snapToSquare(xy: WorldXY, gridSize: number): WorldXY {
  return [Math.round(xy[0] / gridSize) * gridSize, Math.round(xy[1] / gridSize) * gridSize]
}

export function worldContains(bounds: WorldBbox, xy: WorldXY): boolean {
  return xy[0] >= bounds[0] && xy[0] <= bounds[2] && xy[1] >= bounds[1] && xy[1] <= bounds[3]
}
