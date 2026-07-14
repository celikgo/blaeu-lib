/**
 * `@fleximap/plugin-measure` — distance, area and grid bearing.
 *
 * Everything it reports is **planar, in the working CRS, in metres**, via
 * `ctx.crs.area()/length()/distance()/bearing()`. Sphere maths is not survey maths:
 * on the 2 000 m² parcel at 39°N that this repo measures everything against, a
 * spherical area differs from the projected one by square metres — which is enough to
 * move a boundary in a dispute. See `measure.test.ts`, which asserts the two answers
 * differ, so that nobody "optimises" this into `@turf/area` later.
 */

export { measurePlugin, LAYER_IDS } from './plugin.js'

export type {
  MeasureApi,
  MeasureOptions,
  MeasureMode,
  Measurement,
  MeasureSegment,
  BearingReadout,
  AreaUnit,
  LengthUnit,
} from './types.js'

export {
  MEASURE_COLLECTION,
  LABEL_COLLECTION,
  DRAFT_COLLECTION,
  DRAFT_LABEL_COLLECTION,
  TOOL_IDS,
} from './types.js'

export { formatArea, formatBearing, formatLength, toDms } from './format.js'

import type { MeasureApi, MeasureMode, Measurement } from './types.js'

/**
 * The typed seam.
 *
 * With this, `map.plugin('measure')` resolves to {@link MeasureApi} with no cast and
 * no generic, and `map.events.on('measure:complete', (e) => e.payload.measurement)`
 * type-checks with full inference — a typo in the event name is a compile error. A
 * plugin that skips this augmentation is a plugin that feels second-class the moment
 * anyone tries to use it.
 *
 * None of the events are `before:`-prefixed, deliberately: measuring writes nothing a
 * host app could reasonably want to veto. A measurement that a validation rule
 * refuses is a measurement the user is not allowed to *read*, which is not a thing.
 */
declare module '@fleximap/core' {
  interface FlexiPluginRegistry {
    measure: MeasureApi
  }

  interface FlexiEventMap {
    'measure:start': { readonly mode: MeasureMode }
    /** Fired on every pointer move while a shape is open. `measurement.draft` is true. */
    'measure:update': { readonly mode: MeasureMode; readonly measurement: Measurement }
    'measure:complete': { readonly measurement: Measurement }
    /** `count` is the number of *measurements* removed, not the number of features. */
    'measure:clear': { readonly count: number }
  }
}
