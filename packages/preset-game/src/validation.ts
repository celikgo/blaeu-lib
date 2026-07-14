import { bboxAround, type FlexiFeature, type ValidationRule } from '@fleximap/core'
import { ENTITY_PROPERTY, GENERATED_PROPERTY } from './styles.js'
import type { ResolvedGameOptions, WorldXY } from './types.js'
import { createWorldTransform, snapToSquare, worldContains } from './world.js'
import { nearestHexCentre } from './hex.js'

/**
 * The preset's judgement, expressed as rules.
 *
 * Notice how *different* these are from a cadastre's — no self-intersection, no
 * overlap with neighbours, no minimum area — and how identical the machinery is. A
 * rule is a rule; the domain decides what is worth rejecting. In a land registry an
 * overlap is a legal dispute and a gap is a digitisation artefact. In a level editor
 * an entity outside the world is a crash waiting to happen, and two entities on one
 * tile is usually fine and occasionally the whole mechanic — which is why the
 * severity of the second one is an *option*, and the severity of the first is not
 * quite.
 *
 * Both rules are pure functions of the options: a preset is data (preset rule 1), so
 * a rule it declares cannot close over a map.
 */

/** The rule ids. Exported so `overridePreset` and `validation.remove()` can name them. */
export const RULE_IN_BOUNDS = 'game.entity.inBounds'
export const RULE_TILE_OCCUPIED = 'game.entity.tileOccupied'

export function gameRules(options: ResolvedGameOptions): readonly ValidationRule[] {
  const rules: ValidationRule[] = [inBoundsRule(options)]
  if (options.occupancySeverity !== 'off') rules.push(tileOccupiedRule(options))
  return rules
}

/**
 * An entity must be inside the world.
 *
 * `error` by default, so the placement is never written — not "written and flagged".
 * A game engine that loads a level and finds an entity at (−9000, 12) does not show
 * a warning; it indexes outside its chunk array and crashes on someone else's
 * machine.
 */
function inBoundsRule(options: ResolvedGameOptions): ValidationRule {
  const transform = createWorldTransform(options.unitsPerDegree)

  return {
    id: RULE_IN_BOUNDS,
    severity: options.boundsSeverity,
    appliesTo: isEntity,

    check(feature, ctx) {
      const point = entityPoint(feature)
      if (!point) return []

      const xy = transform.toWorld(point)
      if (worldContains(options.bounds, xy)) return []

      return [
        {
          rule: RULE_IN_BOUNDS,
          severity: options.boundsSeverity,
          message: ctx.t('game.rule.outOfBounds', { entity: label(feature) }),
          feature: feature.id,
          at: point,
          // The numbers a level designer would need to fix it, in the units they think
          // in. An issue that says "out of bounds" and makes you go and work out where
          // is an issue that gets ignored.
          data: { x: xy[0], y: xy[1], bounds: options.bounds },
        },
      ]
    },
  }
}

/**
 * One entity per tile.
 *
 * A `warning` by default: stacking a torch on a crate is normal, and a rule that
 * blocked it would make the editor feel broken. A tower-defence game where a tile
 * holds exactly one tower sets `occupancySeverity: 'error'` and gets the block for
 * free — which is the entire preset argument in one option.
 *
 * Generated features are exempt. A generator that scatters four crates around a
 * building is *meant* to put them near each other, and having the decoration it
 * produced veto the placement that produced it is a spectacularly confusing bug.
 */
function tileOccupiedRule(options: ResolvedGameOptions): ValidationRule {
  const transform = createWorldTransform(options.unitsPerDegree)
  const severity = options.occupancySeverity === 'off' ? 'warning' : options.occupancySeverity

  return {
    id: RULE_TILE_OCCUPIED,
    severity,
    appliesTo: (feature) => isEntity(feature) && feature.properties[GENERATED_PROPERTY] !== true,

    check(feature, ctx) {
      const point = entityPoint(feature)
      if (!point) return []

      const tile = tileKey(transform.toWorld(point), options)

      // Spatially indexed, not a scan: this runs on the commit path of every single
      // placement, and a level with fifty thousand entities is not unusual. The radius
      // is in the working CRS's unit — which, because the working CRS *is* the world
      // plane, means it is in tiles. The kernel's own helper, doing game maths.
      const near = ctx.store
        .collection(feature.meta.collection)
        .query(bboxAround(ctx.crs, point, options.gridSize))

      for (const other of near) {
        if (other.id === feature.id) continue
        if (!isEntity(other) || other.properties[GENERATED_PROPERTY] === true) continue

        const otherPoint = entityPoint(other)
        if (!otherPoint) continue
        if (tileKey(transform.toWorld(otherPoint), options) !== tile) continue

        return [
          {
            rule: RULE_TILE_OCCUPIED,
            severity,
            message: ctx.t('game.rule.tileOccupied', { other: label(other) }),
            feature: feature.id,
            at: point,
            data: { occupiedBy: other.id, tile },
          },
        ]
      }

      return []
    },
  }
}

/* ------------------------------------------------------------------ helpers */

function isEntity(feature: FlexiFeature): boolean {
  return typeof feature.properties[ENTITY_PROPERTY] === 'string'
}

function entityPoint(feature: FlexiFeature): readonly [number, number] | undefined {
  if (feature.geometry.type !== 'Point') return undefined
  const [lng, lat] = feature.geometry.coordinates
  if (lng === undefined || lat === undefined) return undefined
  return [lng, lat]
}

function label(feature: FlexiFeature): string {
  const name = feature.properties['label']
  if (typeof name === 'string') return name
  const type = feature.properties[ENTITY_PROPERTY]
  return typeof type === 'string' ? type : feature.id
}

/**
 * The identity of a tile.
 *
 * Quantised through the grid rather than compared by coordinate: two entities the
 * store rounded to positions 1e-9 units apart are on the same tile, and float
 * equality would say they are not — which is how you get a duplicate that only
 * appears after a save/load round-trip.
 */
function tileKey(xy: WorldXY, options: ResolvedGameOptions): string {
  const centre =
    options.gridType === 'hex'
      ? nearestHexCentre(xy, options.gridSize)
      : snapToSquare(xy, options.gridSize)
  return `${centre[0].toFixed(3)},${centre[1].toFixed(3)}`
}
