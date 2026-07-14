import type { FlexiPlugin, PluginContext } from '@fleximap/core'
import { resolveGameOptions } from '../options.js'
import type { GameOptions, ResolvedGameOptions, WorldApi, WorldXY } from '../types.js'
import { createWorldTransform, snapToSquare, worldContains, worldCrsSpec } from '../world.js'
import { nearestHexCentre } from '../hex.js'

/**
 * Registers the game world as a coordinate reference system, and makes it the
 * working CRS.
 *
 * Three lines of `setup` carry the whole argument of this package: after them, every
 * planar operation the kernel already had — `crs.area()`, `crs.distance()`,
 * `crs.quantise()`, the snap engine's grid provider, the store's ingest
 * quantisation, the coordinate readout — is operating in **world units**, and not one
 * line of the kernel or of any plugin was changed to make that true. The CRS
 * abstraction was the seam; a game world is just a plane, and the kernel was always
 * asking for a plane.
 *
 * ## Why this is a plugin and not `config.crs.working`
 *
 * `FlexiCrsService` is constructed in the `FlexiMap` constructor, from
 * `config.crs.working`, *before* any plugin runs. So a preset that wrote
 * `config: { crs: { working: 'GAME:WORLD' } }` would throw `unknown CRS "GAME:WORLD"`
 * before it ever got the chance to register it. Registration therefore has to happen
 * from a plugin's `setup`, and the preset leaves `crs.working` at its default — where
 * it lives for exactly the few milliseconds between construction and this plugin's
 * setup, during which nothing has been measured and nothing has been ingested.
 *
 * (That ordering is a genuine sharp edge in the kernel rather than a nicety of this
 * preset. A `config.crs.register` hook would remove it.)
 */
export function worldCrsPlugin(options: GameOptions = {}): FlexiPlugin<WorldApi, GameOptions> {
  return {
    id: 'game-world',
    version: '1.0.0',

    setup(ctx: PluginContext<GameOptions>): WorldApi {
      // Options arrive twice: through the factory (the direct form) and through
      // `ctx.options` (the `[worldCrsPlugin, {...}]` tuple form a preset uses).
      // Merging is what makes both spellings mean the same thing.
      const resolved: ResolvedGameOptions = resolveGameOptions({
        ...options,
        ...(ctx.options ?? {}),
      })

      const transform = createWorldTransform(resolved.unitsPerDegree)
      // Round-trip probed by `crs.register` itself, so a broken plane names itself
      // here rather than on the level designer's first click.
      const crs = ctx.crs.register(worldCrsSpec(resolved))

      // Captured *before* we take over, and restored on teardown. A map whose plugins
      // are removed and reinstalled — the teardown test does exactly this — must not
      // be left measuring a level in a CRS whose registration it no longer owns.
      const previous = ctx.crs.working.code
      ctx.crs.setWorking(crs.code)
      ctx.disposables.addFn(() => ctx.crs.setWorking(previous))

      ctx.log.info(
        `world plane "${crs.code}" is now the working CRS: ` +
          `1 world unit = 1/${resolved.unitsPerDegree}°, grid ${resolved.gridSize}, ` +
          `bounds [${resolved.bounds.join(', ')}]`,
      )

      return {
        ...transform,
        code: crs.code,
        bounds: resolved.bounds,
        gridSize: resolved.gridSize,
        gridType: resolved.gridType,
        contains: (xy: WorldXY) => worldContains(resolved.bounds, xy),
        snap: (xy: WorldXY) =>
          resolved.gridType === 'hex'
            ? nearestHexCentre(xy, resolved.gridSize)
            : snapToSquare(xy, resolved.gridSize),
      }
    },
  }
}

declare module '@fleximap/core' {
  interface FlexiPluginRegistry {
    'game-world': WorldApi
  }
}
