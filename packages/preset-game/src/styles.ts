import type { LayerStyle } from '@fleximap/core'
import type { EntityType, ResolvedGameOptions } from './types.js'

/** The property every placed entity carries. Matched by the icon expression below. */
export const ENTITY_PROPERTY = '$entity'

/** Stamped on anything a generator produced, so generators cannot re-trigger on their own output. */
export const GENERATED_PROPERTY = '$generated'

/** The default footprint, in world units, for an entity type that declares no `size`. */
export const DEFAULT_ENTITY_SIZE = 8

/**
 * A MapLibre `match` expression: entity id → icon.
 *
 * ```
 * ['match', ['get', '$entity'], 'tree', '🌲', 'rock', '🪨', '?']
 * ```
 *
 * One layer draws every entity type, and adding a type is a data change rather than
 * a layer change. The alternative — a layer per entity type — is what most tilemap
 * editors do, and it is why they slow down at forty entity types and cannot let a
 * user define a forty-first at runtime.
 *
 * The icon rides in the **text** field, not `icon-image`: a glyph needs no sprite
 * sheet, so the preset renders out of the box with no asset pipeline. A game with a
 * real sprite atlas moves the same expression to `style.native.layout['icon-image']`
 * and changes nothing else.
 */
export function entityIconExpression(entities: readonly EntityType[]): unknown[] {
  const expression: unknown[] = ['match', ['get', ENTITY_PROPERTY]]
  for (const entity of entities) {
    expression.push(entity.id, entity.icon)
  }
  // The fallback is visible on purpose. An entity whose type was removed from the
  // config still exists in the level file, and a silent fallback of '' would erase it
  // from the screen while leaving it in the store — the worst of both.
  expression.push('?')
  return expression
}

/** Entity id → radius in **pixels**, derived from {@link EntityType.size} in world units. */
export function entitySizeExpression(
  entities: readonly EntityType[],
  unitsToPixels: number,
): unknown[] {
  const expression: unknown[] = ['match', ['get', ENTITY_PROPERTY]]
  for (const entity of entities) {
    expression.push(entity.id, ((entity.size ?? DEFAULT_ENTITY_SIZE) / 2) * unitsToPixels)
  }
  expression.push((DEFAULT_ENTITY_SIZE / 2) * unitsToPixels)
  return expression
}

/**
 * A pixel per world unit is a placeholder scale.
 *
 * A circle radius in MapLibre is in *pixels*, and pixels-per-world-unit depends on
 * the zoom — so a truly correct radius is a zoom interpolation, which belongs to the
 * game's art direction rather than to a preset. This is the honest middle: entities
 * are legible at the zoom the editor opens at, and a game that cares overrides the
 * layer's style.
 */
const PIXELS_PER_UNIT = 1

export function entityStyle(options: ResolvedGameOptions): LayerStyle {
  return {
    circle: {
      color: options.gridColor,
      radius: entitySizeExpression(options.entities, PIXELS_PER_UNIT),
      strokeColor: '#4ade80',
      strokeWidth: 1,
    },
    symbol: {
      text: entityIconExpression(options.entities),
      size: 14,
    },
  }
}

/** Terrain zones: a translucent fill, so the grid under them stays readable. */
export function zoneStyle(options: ResolvedGameOptions): LayerStyle {
  return {
    fill: {
      color: options.zoneColor,
      opacity: 0.18,
      outlineColor: options.zoneColor,
    },
    line: {
      color: options.zoneColor,
      width: options.gridLineWidth,
    },
  }
}
