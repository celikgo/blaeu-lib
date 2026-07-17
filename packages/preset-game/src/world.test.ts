import { describe, expect, it } from 'vitest'
import { BlaeuCrsService } from '@blaeu/core'
import type { CrsService, LngLat } from '@blaeu/core'

import {
  assertWorldFits,
  createWorldTransform,
  snapToSquare,
  worldContains,
  worldCrsSpec,
  worldRadius,
} from './world.js'
import { resolveGameOptions } from './options.js'
import { hexCentre, hexCircumradius, nearestHexCentre } from './hex.js'
import type { WorldBbox, WorldXY } from './types.js'

/**
 * The world plane is the most interesting claim in the package: that the kernel's
 * planar maths works on a game plane, because a game plane is just a plane and the
 * kernel was only ever asking for one.
 *
 * So these tests do not stop at "the affine helper is affine" — that would be testing
 * arithmetic. They push world coordinates through the *real* `CrsService`, which
 * means through the *real* proj4 `+proj=eqc` converter, and check that what comes back
 * is the number the level designer typed. That is the round trip a placed entity
 * actually makes.
 */

const UNITS_PER_DEGREE = 100_000

function crsFor(options = {}): { crs: CrsService; code: string } {
  const o = resolveGameOptions(options)
  // The service is constructed exactly as `BlaeuMap` constructs it — decimal places,
  // not a grid — and then the world plane is registered into it, exactly as
  // `worldCrsPlugin` does.
  const crs = new BlaeuCrsService({ working: 'EPSG:3857', display: 'projected', precision: 3 })
  const registered = crs.register(worldCrsSpec(o))
  crs.setWorking(registered.code)
  return { crs, code: registered.code }
}

/** Metric assertion, in the unit the world is actually denominated in. */
function expectWithinUnits(actual: WorldXY, expected: WorldXY, tolerance: number): void {
  const distance = Math.hypot(actual[0] - expected[0], actual[1] - expected[1])
  expect(
    distance,
    `expected [${actual.join(', ')}] within ${tolerance} world units of [${expected.join(', ')}], but it was ${distance}`,
  ).toBeLessThanOrEqual(tolerance)
}

/* ------------------------------------------------------------------------- */
/* The affine map                                                              */
/* ------------------------------------------------------------------------- */

describe('createWorldTransform', () => {
  it('is a pure scale — no trigonometry, no latitude dependence', () => {
    const transform = createWorldTransform(UNITS_PER_DEGREE)

    expect(transform.toLngLat([0, 0])).toEqual([0, 0])
    expect(transform.toLngLat([100_000, -50_000])).toEqual([1, -0.5])
    expect(transform.toWorld([1, -0.5])).toEqual([100_000, -50_000])
  })

  /**
   * The scale-independence the whole trick rests on: a displacement of one world unit
   * is the same number of degrees at the origin and at the far corner of the world.
   * On the Earth it would not be — which is the difference between a plane and a
   * sphere, and the reason a game must not be measured on a sphere.
   */
  it('has the same scale everywhere in the world, unlike a sphere', () => {
    const transform = createWorldTransform(UNITS_PER_DEGREE)

    const atOrigin = transform.toLngLat([1, 0])[0] - transform.toLngLat([0, 0])[0]
    const atCorner = transform.toLngLat([2049, 2048])[0] - transform.toLngLat([2048, 2048])[0]

    expect(atOrigin).toBeCloseTo(atCorner, 18)
  })

  it('round-trips world → lng/lat → world exactly, across the whole default world', () => {
    const transform = createWorldTransform(UNITS_PER_DEGREE)

    for (let x = -2048; x <= 2048; x += 37) {
      for (let y = -2048; y <= 2048; y += 53) {
        // The configured precision is a millitile. The affine round trip is far better
        // than that — this asserts a nanounit, a million times finer.
        expectWithinUnits(transform.toWorld(transform.toLngLat([x, y])), [x, y], 1e-9)
      }
    }
  })

  it('derives the sphere radius that makes degrees linear in world units', () => {
    // x = R·λ with λ in radians; R = unitsPerDegree · 180/π makes x = unitsPerDegree · lng.
    expect(worldRadius(UNITS_PER_DEGREE)).toBeCloseTo((100_000 * 180) / Math.PI, 9)
  })
})

/* ------------------------------------------------------------------------- */
/* Through the real CRS — the claim that actually matters                      */
/* ------------------------------------------------------------------------- */

describe('the world plane, through the kernel’s own CrsService', () => {
  it('registers, and becomes the working CRS', () => {
    const { crs, code } = crsFor()

    expect(code).toBe('GAME:WORLD')
    expect(crs.working.code).toBe('GAME:WORLD')
    expect(crs.working.unit).toBe('metre')
    // The registered def carries the *grid*, in world units — a millitile.
    expect(crs.working.precision).toBe(0.001)
  })

  /**
   * `crs.working.forward` is what `InteractionContext.xy` calls on every pointer move,
   * and what every planar facility in the kernel measures in. If it does not agree with
   * the preset's own `WorldTransform`, then a snap provider and an entity would be
   * working in two different coordinate systems that look identical — the worst kind of
   * bug this package could have.
   */
  it('agrees with the WorldTransform to well inside the configured precision', () => {
    const { crs } = crsFor()
    const transform = createWorldTransform(UNITS_PER_DEGREE)

    for (const xy of [
      [0, 0],
      [32, 32],
      [-2048, -2048],
      [2048, 2048],
      [128.5, -96.25],
      [1, 1],
    ] as const) {
      const viaTransform = transform.toLngLat(xy)
      const viaCrs = crs.working.inverse(xy)

      // Same degrees, either way round.
      expect(viaCrs[0]).toBeCloseTo(viaTransform[0], 12)
      expect(viaCrs[1]).toBeCloseTo(viaTransform[1], 12)

      // And forward is its inverse: a micro-unit is a thousandth of the configured
      // millitile precision, so the proj4 sandwich loses nothing the store can see.
      expectWithinUnits(crs.working.forward(viaTransform), xy, 1e-6)
    }
  })

  it('round-trips lng/lat → world → lng/lat through proj4, over the whole world', () => {
    const { crs } = crsFor()
    const transform = createWorldTransform(UNITS_PER_DEGREE)

    for (let x = -2048; x <= 2048; x += 101) {
      for (let y = -2048; y <= 2048; y += 97) {
        const lngLat: LngLat = transform.toLngLat([x, y])
        const back = crs.working.inverse(crs.working.forward(lngLat))
        expect(back[0]).toBeCloseTo(lngLat[0], 12)
        expect(back[1]).toBeCloseTo(lngLat[1], 12)
      }
    }
  })

  /**
   * The payoff. `crs.distance` and `crs.area` are the kernel's own survey-grade
   * helpers, written for a land registry, and they were never told about games. On the
   * world plane they return **tiles** and **tiles²**, exactly, with no correction —
   * because the plane they measure in *is* the game world.
   */
  it('makes the kernel’s own distance and area helpers speak world units', () => {
    const { crs } = crsFor()
    const transform = createWorldTransform(UNITS_PER_DEGREE)
    const at = (xy: WorldXY): LngLat => transform.toLngLat(xy)

    // A 3-4-5 triangle in world units.
    expect(crs.distance(at([0, 0]), at([300, 400]))).toBeCloseTo(500, 6)

    // A 64 × 32 rectangle: 2048 square world units, i.e. two tiles at gridSize 32.
    const area = crs.area({
      type: 'Polygon',
      coordinates: [
        [[...at([0, 0])], [...at([64, 0])], [...at([64, 32])], [...at([0, 32])], [...at([0, 0])]],
      ],
    })
    expect(area).toBeCloseTo(2048, 3)
  })

  it('scales with unitsPerDegree — a bigger world is a smaller patch of lng/lat', () => {
    const { crs } = crsFor({
      unitsPerDegree: 1_000_000,
      bounds: [-50_000, -50_000, 50_000, 50_000],
    })

    // A 100 000-unit world in a 0.1° patch. Same maths, a different scale — and the
    // distance helper still returns world units.
    expect(crs.working.inverse([50_000, 50_000])[0]).toBeCloseTo(0.05, 9)
    expect(
      crs.distance(crs.working.inverse([0, 0]), crs.working.inverse([30_000, 40_000])),
    ).toBeCloseTo(50_000, 3)
  })

  it('publishes the world’s own extent as the CRS bounds, in 4326', () => {
    const spec = worldCrsSpec(resolveGameOptions())

    // So the kernel's "you are outside this CRS's validity extent" machinery reports a
    // placement outside the level, for free.
    expect(spec.bounds).toEqual([-0.02048, -0.02048, 0.02048, 0.02048])
    // And the code is deliberately not an EPSG number — nobody may mistake it for one.
    expect(spec.code).toBe('GAME:WORLD')
  })
})

/* ------------------------------------------------------------------------- */
/* assertWorldFits — the guard on the trick                                     */
/* ------------------------------------------------------------------------- */

describe('assertWorldFits', () => {
  const transform = createWorldTransform(UNITS_PER_DEGREE)

  it('accepts the default world, which occupies a 0.04° patch of the equator', () => {
    expect(() => assertWorldFits([-2048, -2048, 2048, 2048], transform)).not.toThrow()
  })

  it('accepts a world exactly on the ±60° ceiling, and rejects one just past it', () => {
    // 60° × 100 000 units/° = 6 000 000 units. The boundary is inclusive, and a world
    // one unit larger is not — the guard has to be a line somewhere and this pins it.
    const onTheLine: WorldBbox = [0, 0, 6_000_000, 6_000_000]
    const overIt: WorldBbox = [0, 0, 6_000_001, 6_000_000]

    expect(() => assertWorldFits(onTheLine, transform)).not.toThrow()
    expect(() => assertWorldFits(overIt, transform)).toThrow(/outside the ±60° band/)
  })

  it('rejects a world too large for the lng/lat patch it maps onto', () => {
    // 40 000 000 units at the default scale is 400° of longitude: not merely
    // ill-conditioned, but off the planet. The message must say so.
    expect(() =>
      assertWorldFits([-20_000_000, -20_000_000, 20_000_000, 20_000_000], transform),
    ).toThrow(/±200\.0°/)
  })

  it('names the scale that would have fitted, so the fix is in the error', () => {
    // 20 000 000 units / 60° = 333 333 units/° minimum; the suggestion is the power of
    // ten below it, which is a number a human would actually type.
    expect(() =>
      assertWorldFits([-20_000_000, -20_000_000, 20_000_000, 20_000_000], transform),
    ).toThrow(/try 100000/)
  })

  /**
   * The guard is not decoration: `worldCrsSpec` calls it, so a mis-scaled world is
   * refused at *preset construction*, before a map exists. The alternative is a level
   * editor whose camera silently refuses to fit its own bounds.
   */
  it('runs at preset construction, not on the first click', () => {
    expect(() =>
      worldCrsSpec(
        resolveGameOptions({ bounds: [-20_000_000, -20_000_000, 20_000_000, 20_000_000] }),
      ),
    ).toThrow(/±200\.0°/)
  })

  it('lets an enormous world through if the scale is chosen to suit it', () => {
    // The same world, at a scale that fits: this is the escape hatch the error suggests,
    // and it must actually work.
    expect(() =>
      worldCrsSpec(
        resolveGameOptions({
          bounds: [-20_000_000, -20_000_000, 20_000_000, 20_000_000],
          unitsPerDegree: 1_000_000,
        }),
      ),
    ).not.toThrow()
  })
})

/* ------------------------------------------------------------------------- */
/* The lattices                                                                */
/* ------------------------------------------------------------------------- */

describe('grid quantisation', () => {
  it('snaps to the nearest square intersection, and is exact on a multiple', () => {
    expect(snapToSquare([0, 0], 32)).toEqual([0, 0])
    expect(snapToSquare([100, 100], 32)).toEqual([96, 96])
    expect(snapToSquare([-40, 17], 32)).toEqual([-32, 32])
    // A point already on the grid stays put — snapping must be idempotent, or a
    // re-imported level would drift a tile per round trip.
    expect(snapToSquare(snapToSquare([100, 100], 32), 32)).toEqual([96, 96])
  })

  it('finds the nearest hex centre, and every centre is its own nearest', () => {
    for (let column = -3; column <= 3; column++) {
      for (let row = -3; row <= 3; row++) {
        const centre = hexCentre(column, row, 32)
        expectWithinUnits(nearestHexCentre(centre, 32), centre, 1e-9)

        // Nudged by a fifth of the circumradius in any direction, it still resolves to
        // the same cell — the property a snap provider needs and the naive cube-rounding
        // inverse gets wrong near a staggered row boundary.
        const nudge = hexCircumradius(32) / 5
        for (const [dx, dy] of [
          [nudge, 0],
          [-nudge, 0],
          [0, nudge],
          [0, -nudge],
        ] as const) {
          expectWithinUnits(nearestHexCentre([centre[0] + dx, centre[1] + dy], 32), centre, 1e-9)
        }
      }
    }
  })

  it('knows what is inside the world, inclusive of its edges', () => {
    const bounds: WorldBbox = [-2048, -2048, 2048, 2048]

    expect(worldContains(bounds, [0, 0])).toBe(true)
    expect(worldContains(bounds, [2048, 2048])).toBe(true)
    expect(worldContains(bounds, [2048.001, 0])).toBe(false)
    expect(worldContains(bounds, [0, -2049])).toBe(false)
  })
})
