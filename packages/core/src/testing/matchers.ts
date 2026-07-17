import type { LngLat } from '../types/common.js'
import { distanceMetres } from './fixtures.js'

/**
 * Assert that two coordinates are within `metres` of each other.
 *
 * ```ts
 * expectWithinMetres(moved, expected, 0.001)   // 1 mm — the cadastral grid
 * ```
 *
 * ## Why not `toBeCloseTo(lng, 6)`
 *
 * Because a decimal place is not a distance. A degree of longitude is ~111 km at
 * the equator, ~85 km at Ankara (39.93°N), and ~56 km at Oslo (60°N), so
 * `toBeCloseTo(lng, 6)` — "within 5×10⁻⁷ degrees" — is a tolerance of 5.6 cm on the
 * equator and 2.8 cm in Oslo. The same assertion silently tightens as you move
 * north, and it is *twice as strict in longitude as in latitude* at every latitude
 * but zero.
 *
 * The result is a test that passes in Ankara, fails in Oslo, and sends the next
 * maintainer looking for a bug in the snap engine that was never there. A metric
 * tolerance says what it means: this vertex must land within one millimetre of that
 * one, everywhere on Earth.
 *
 * Deliberately framework-agnostic — it throws a plain `Error` rather than reaching
 * for `expect`. `@blaeu/core/testing` is a *published* entry point, and a
 * package that drags Vitest into a consumer's dependency graph because its test
 * helper imports it is a package nobody trusts.
 */
export function expectWithinMetres(actual: LngLat, expected: LngLat, metres: number): void {
  const distance = distanceMetres(actual, expected)

  // Negated rather than `>`: a NaN coordinate makes every comparison false, and a
  // NaN that passes an assertion is exactly the bug this file exists to catch.
  if (!(distance <= metres)) {
    throw new Error(
      `[blaeu] expected [${actual[0]}, ${actual[1]}] to be within ${formatMetres(metres)} of ` +
        `[${expected[0]}, ${expected[1]}], but it is ${formatMetres(distance)} away.`,
    )
  }
}

/** The predicate behind {@link expectWithinMetres}, for use inside a custom assertion. */
export function withinMetres(actual: LngLat, expected: LngLat, metres: number): boolean {
  return distanceMetres(actual, expected) <= metres
}

function formatMetres(metres: number): string {
  if (Number.isNaN(metres)) return 'NaN metres (a coordinate is not a number)'
  if (metres < 0.01) return `${(metres * 1000).toPrecision(3)} mm`
  return `${metres.toPrecision(4)} m`
}

export { distanceMetres }
