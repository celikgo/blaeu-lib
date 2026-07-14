import type { FeatureInput, FlexiFeature } from '@fleximap/core'
import { ENTITY_PROPERTY } from './styles.js'
import type { EntityGenerator, WorldXY } from './types.js'

/**
 * Generators, and a worked example of one.
 *
 * A generator is just a function from "what was placed" to "what else should exist".
 * It runs inside the commit pipeline (see `plugins/entity.ts`), which buys it three
 * things it would otherwise have to build: its output is validated by the same rules
 * as a hand-placed entity, it lands in the same undo step, and it may be async.
 */

export interface ScatterOptions {
  /** The entity type id to scatter. Must be one of the preset's declared types. */
  readonly type: string
  /** How many, per triggering entity. */
  readonly count: number
  /** Maximum distance from the trigger, in **world units**. */
  readonly radius: number
  /** Only fire for these entity types. Omit to fire for every placement. */
  readonly around?: readonly string[]
  /** Where the scattered features land. Defaults to the trigger's own collection. */
  readonly collection?: string
  /**
   * Deterministic scatter, seeded per triggering entity.
   *
   * Default. A level editor that scatters *differently* every time it re-runs is a
   * level editor whose output cannot be diffed, reviewed, or reproduced from a bug
   * report — so the randomness is a hash of the trigger's position, not `Math.random`.
   */
  readonly seed?: number
}

/**
 * Scatter decorations around each placed entity.
 *
 * ```ts
 * gameMapPreset({
 *   entities: [{ id: 'hut', label: 'Hut', icon: '🛖' }, { id: 'tree', label: 'Tree', icon: '🌲' }],
 *   generators: [scatterAround({ type: 'tree', count: 4, radius: 24, around: ['hut'] })],
 * })
 * ```
 *
 * Placing one hut writes five features and one undo step.
 */
export function scatterAround(options: ScatterOptions): EntityGenerator {
  const seed = options.seed ?? 0x9e3779b9

  return ({ placed, world }): readonly FeatureInput[] => {
    const out: FeatureInput[] = []

    for (const trigger of placed) {
      if (options.around && !options.around.includes(entityTypeOf(trigger) ?? '')) continue

      const origin = world.toWorld(pointOf(trigger) ?? [0, 0])
      const random = mulberry32(hash(origin, seed))

      for (let i = 0; i < options.count; i++) {
        // Uniform *in the disc*, not in (angle, radius): sampling radius linearly
        // clusters everything at the centre, and a "scattered" forest that is visibly
        // a ring around each hut is the classic tell.
        const angle = random() * Math.PI * 2
        const distance = options.radius * Math.sqrt(random())
        const at: WorldXY = [
          origin[0] + Math.cos(angle) * distance,
          origin[1] + Math.sin(angle) * distance,
        ]
        if (!world.contains(at)) continue

        out.push({
          geometry: { type: 'Point', coordinates: [...world.toLngLat(at)] },
          properties: { [ENTITY_PROPERTY]: options.type },
          ...(options.collection !== undefined
            ? { meta: { collection: options.collection } }
            : { meta: { collection: trigger.meta.collection } }),
        })
      }
    }

    return out
  }
}

/* ------------------------------------------------------------------ helpers */

function entityTypeOf(feature: FlexiFeature): string | undefined {
  const id = feature.properties[ENTITY_PROPERTY]
  return typeof id === 'string' ? id : undefined
}

function pointOf(feature: FlexiFeature): readonly [number, number] | undefined {
  if (feature.geometry.type !== 'Point') return undefined
  const [lng, lat] = feature.geometry.coordinates
  return lng === undefined || lat === undefined ? undefined : [lng, lat]
}

/** Position → seed. Two huts on different tiles get different forests; the same hut always gets the same one. */
function hash(xy: WorldXY, seed: number): number {
  let h = seed ^ Math.imul(Math.round(xy[0] * 1000), 0x27d4eb2d)
  h = Math.imul(h ^ Math.round(xy[1] * 1000), 0x85ebca6b)
  return (h ^ (h >>> 15)) >>> 0
}

/** A small, fast, seedable PRNG. Not cryptographic, and does not need to be. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
