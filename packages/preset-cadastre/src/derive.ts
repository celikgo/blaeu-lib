import {
  BlaeuCrsService,
  type CollectionId,
  type CommitMiddleware,
  type CrsCode,
  type BlaeuFeature,
  type Geometry,
} from '@blaeu/core'

import { AREA_PROPERTY } from './schema.js'

export interface DeriveAreaOptions {
  readonly crs: CrsCode
  readonly precision: number
  readonly collection: CollectionId
  readonly decimals: number
  /** The property to write. Only change it to match a legacy schema. */
  readonly property?: string
}

/** Runs before validation (priority 0), so a rule that reads `yuzolcumu` sees the fresh one. */
export const DERIVE_AREA_PRIORITY = 100
export const DERIVE_AREA_ID = 'cadastre:derive-area'

/**
 * Stamp the planar area onto every parcel on its way into the store.
 *
 * Two decisions are baked in here, and both are cadastral rather than technical.
 *
 * **Area is derived, not typed.** The number on the deed and the number implied by
 * the boundary must be the same number, and the only way to guarantee that is for
 * a human never to be able to type one of them. If the two disagree, the surveyor
 * is arguing with themselves — the parcel is what its corners say it is.
 *
 * **Planar, in the working CRS.** `ctx.crs.area()` projects to metres first.
 * Spherical area on a 2 000 m² parcel at 39°N is wrong by square metres, and a
 * land registry that catches you doing it is right to.
 *
 * The trade-off worth knowing: `CommitContext` carries no `CrsService`, so this
 * middleware builds its own from the same CRS code the preset was given. It is a
 * pure construction (no DOM, no globals — preset rule 1 holds), but it does mean a
 * runtime `map.crs.setWorking(other)` would leave this projecting into the *original*
 * plane. For a cadastre product the working CRS is a deployment decision, not a
 * session one, so that is the right failure mode — but if the kernel ever puts the
 * CRS on `CommitContext`, delete this instance and read it from the context.
 */
export function deriveAreaMiddleware(options: DeriveAreaOptions): CommitMiddleware {
  const property = options.property ?? AREA_PROPERTY
  const crs = new BlaeuCrsService({
    working: options.crs,
    display: 'projected',
    precision: options.precision,
  })
  const factor = 10 ** options.decimals

  return async (ctx, next) => {
    if (ctx.operation === 'remove') {
      await next()
      return
    }

    ctx.features = ctx.features.map((feature) => {
      if (feature.meta.collection !== options.collection) return feature
      if (!isPolygonal(feature.geometry)) return feature

      const area = Math.round(crs.area(feature.geometry) * factor) / factor
      // Identity when the number has not moved, so a no-op update does not bump the
      // feature's version and light up every "this parcel changed" listener.
      if (feature.properties[property] === area) return feature

      return withProperty(feature, property, area)
    })

    await next()
  }
}

function isPolygonal(geometry: Geometry): boolean {
  return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon'
}

function withProperty(feature: BlaeuFeature, property: string, value: number): BlaeuFeature {
  return {
    ...feature,
    properties: { ...feature.properties, [property]: value },
  }
}
